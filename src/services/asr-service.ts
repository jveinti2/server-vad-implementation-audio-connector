import EventEmitter from "events";
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  AudioStream,
  LanguageCode,
} from "@aws-sdk/client-transcribe-streaming";

/*
 * Esta clase proporciona soporte ASR para el audio entrante del Cliente usando
 * Amazon Transcribe para una transcripción precisa en tiempo real.
 */
export class ASRService {
  private emitter = new EventEmitter();
  private state = "None";
  private client: TranscribeStreamingClient;
  private audioBuffer: Buffer[] = [];
  private isStreaming = false;

  // Configuración para detección basada en inactividad de transcripción
  private lastPartialTranscript = "";
  private lastTranscriptUpdateTime = Date.now();
  private readonly NO_NEW_TEXT_TIMEOUT_MS = 1500; // 1.5 segundos sin cambios en el texto
  private inactivityCheckIntervalId: NodeJS.Timeout | null = null;

  // Detección de silencio inicial
  private firstAudioReceivedTime = 0;
  private hasReceivedTranscription = false;
  private readonly INITIAL_SILENCE_TIMEOUT_MS = 3000; // 3 segundos sin texto = silencio inicial

  // Tiempo máximo absoluto para una transcripción
  private readonly MAX_TRANSCRIPTION_DURATION_MS = 20000; // 20 segundos máximo
  private maxDurationTimeoutId: NodeJS.Timeout | null = null;

  // Métricas de tiempo
  private processingStartTime = 0;
  private metrics = {
    audioToFirstTranscription: 0,
    totalProcessingTime: 0,
  };

  // Otras configuraciones
  private debugger = ASRDebugger.getInstance();
  private lastTranscriptionStartTime = 0;
  private readonly MIN_TRANSCRIPTION_INTERVAL = 1000;
  private accumulatedText = "";

  // Contador de intentos de procesar transcripción final
  private finalTranscriptionAttempts = 0;
  private readonly MAX_FINAL_ATTEMPTS = 2; // Aumentado a 2 intentos para mejor captura
  private hasSentFinalTranscript = false;

  constructor() {
    // AWS Transcribe configuración
    this.client = new TranscribeStreamingClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
      requestHandler: {
        timeout: 8000,
      },
    });

    this.debugger.enable("minimal");

    // Iniciar verificador de inactividad
    this.startInactivityCheck();
  }

  // Método para iniciar el verificador de inactividad
  private startInactivityCheck() {
    // Limpiar intervalo previo si existe
    this.stopInactivityCheck();

    // Programar finalización forzada después de tiempo máximo
    this.maxDurationTimeoutId = setTimeout(() => {
      if (this.state === "Processing" && this.audioBuffer.length > 0) {
        console.log(
          `🎤 [ASR] ⏱️ Tiempo máximo alcanzado (${
            this.MAX_TRANSCRIPTION_DURATION_MS / 1000
          }s) - Finalizando transcripción`
        );
        this.finishTranscription();
      }
    }, this.MAX_TRANSCRIPTION_DURATION_MS);

    // Crear intervalo para verificar inactividad
    this.inactivityCheckIntervalId = setInterval(() => {
      if (this.state === "Processing") {
        // Si hay texto acumulado, verificar tiempo desde última actualización
        if (this.accumulatedText.length > 0) {
          const timeSinceLastUpdate =
            Date.now() - this.lastTranscriptUpdateTime;

          // Solo mostrar log cada segundo para no saturar
          if (timeSinceLastUpdate > 1000 && timeSinceLastUpdate % 1000 < 250) {
            console.log(
              `🎤 [ASR] ⏱️ ${
                Math.round(timeSinceLastUpdate / 100) / 10
              }s sin cambios en texto (umbral: ${
                this.NO_NEW_TEXT_TIMEOUT_MS / 1000
              }s)`
            );
          }

          // Si han pasado más de NO_NEW_TEXT_TIMEOUT_MS sin cambios
          if (timeSinceLastUpdate > this.NO_NEW_TEXT_TIMEOUT_MS) {
            console.log(
              `🎤 [ASR] ⏱️ ${
                Math.round(timeSinceLastUpdate / 100) / 10
              }s sin cambios en texto - Finalizando transcripción`
            );
            this.finishTranscription();
          }
        }
        // Si no hay texto pero tenemos audio durante mucho tiempo, verificar silencio inicial
        else if (
          this.firstAudioReceivedTime > 0 &&
          !this.hasReceivedTranscription
        ) {
          const timeSinceFirstAudio = Date.now() - this.firstAudioReceivedTime;

          // Solo mostrar log cada segundo para no saturar
          if (timeSinceFirstAudio > 1000 && timeSinceFirstAudio % 1000 < 250) {
            console.log(
              `🎤 [ASR] ⏱️ ${
                Math.round(timeSinceFirstAudio / 100) / 10
              }s sin detectar voz (umbral: ${
                this.INITIAL_SILENCE_TIMEOUT_MS / 1000
              }s)`
            );
          }

          if (timeSinceFirstAudio > this.INITIAL_SILENCE_TIMEOUT_MS) {
            console.log(
              `🎤 [ASR] 🔇 ${
                this.INITIAL_SILENCE_TIMEOUT_MS / 1000
              }s sin texto - Silencio inicial detectado`
            );
            this.finishTranscription();
          }
        }
      }
    }, 250);
  }

  // Método para detener el verificador de inactividad
  private stopInactivityCheck() {
    if (this.inactivityCheckIntervalId) {
      clearInterval(this.inactivityCheckIntervalId);
      this.inactivityCheckIntervalId = null;
    }

    if (this.maxDurationTimeoutId) {
      clearTimeout(this.maxDurationTimeoutId);
      this.maxDurationTimeoutId = null;
    }
  }

  on(event: string, listener: (...args: any[]) => void): ASRService {
    this.emitter.addListener(event, listener);
    return this;
  }

  getState(): string {
    return this.state;
  }

  // Obtener métricas de rendimiento
  getMetrics(): {
    audioToFirstTranscription: number;
    totalProcessingTime: number;
  } {
    return { ...this.metrics };
  }

  /*
   * Reinicia el servicio ASR para un nuevo turno del usuario.
   * Debería llamarse cada vez que es turno del usuario de hablar.
   */
  resetForUserTurn(): ASRService {
    // Reset completo para un nuevo turno
    this.state = "None";
    this.audioBuffer = [];
    this.resetAccumulation();
    this.isStreaming = false;
    this.firstAudioReceivedTime = 0;
    this.hasReceivedTranscription = false;
    this.processingStartTime = 0;
    this.finalTranscriptionAttempts = 0;
    this.hasSentFinalTranscript = false;
    this.metrics = {
      audioToFirstTranscription: 0,
      totalProcessingTime: 0,
    };

    // Reiniciar el verificador de inactividad
    this.startInactivityCheck();

    console.log(`🎤 [ASR] 🔄 Reiniciado para turno del usuario`);

    return this;
  }

  // Método para reiniciar acumulación de texto
  private resetAccumulation(): void {
    this.accumulatedText = "";
    this.lastPartialTranscript = "";
    this.lastTranscriptUpdateTime = Date.now();
  }

  /*
   * Procesa los datos de audio recibidos del cliente.
   * Acumula el audio y lo envía a AWS Transcribe para su procesamiento.
   */
  processAudio(data: Uint8Array): ASRService {
    if (this.state === "Complete") {
      return this;
    }

    // Registrar el tiempo del primer audio recibido para métricas
    if (this.firstAudioReceivedTime === 0) {
      this.firstAudioReceivedTime = Date.now();
    }

    // Inicializar estado si es necesario
    if (this.state === "None") {
      this.state = "Processing";
      this.processingStartTime = Date.now();
      this.lastTranscriptUpdateTime = Date.now();
    }

    // Convertir y almacenar el audio
    const pcmData = this.convertMuLawToPCM(data);
    this.audioBuffer.push(pcmData);

    // Iniciar transcripción proactivamente si tenemos suficiente audio
    const canStartTranscription =
      this.state === "Processing" &&
      !this.isStreaming &&
      this.audioBuffer.length >= 5 &&
      Date.now() - this.lastTranscriptionStartTime >
        this.MIN_TRANSCRIPTION_INTERVAL;

    if (canStartTranscription) {
      this.startTranscription();
    }

    return this;
  }

  /*
   * Inicia la transcripción en streaming con AWS Transcribe.
   */
  private async startTranscription() {
    // Evitar iniciar si ya hay una en curso o si ya está completo
    if (this.isStreaming || this.state === "Complete") return;

    this.isStreaming = true;
    this.lastTranscriptionStartTime = Date.now();

    try {
      // Configurar stream de audio
      const thisService = this;
      const audioStream = async function* () {
        for (const chunk of thisService.audioBuffer) {
          yield { AudioEvent: { AudioChunk: chunk } };
        }
      };

      // Configuración de transcripción
      const command = new StartStreamTranscriptionCommand({
        LanguageCode: LanguageCode.ES_ES,
        MediaEncoding: "pcm",
        MediaSampleRateHertz: 8000,
        AudioStream: audioStream() as AsyncIterable<AudioStream>,
        EnablePartialResultsStabilization: true,
        PartialResultsStability: "high",
      });

      const response = await this.client.send(command);

      if (response.TranscriptResultStream) {
        // Procesar resultados en tiempo real
        for await (const event of response.TranscriptResultStream) {
          // Verificar si la transcripción ya se completó mientras procesábamos
          if (this.state === "Complete") {
            break;
          }

          if (event.TranscriptEvent?.Transcript?.Results) {
            const results = event.TranscriptEvent.Transcript.Results;

            for (const result of results) {
              if (result.Alternatives && result.Alternatives.length > 0) {
                const transcript = result.Alternatives[0].Transcript || "";
                const confidence =
                  result.Alternatives[0].Items?.[0]?.Confidence || 0.0;

                // Detectar cualquier texto nuevo como actividad
                if (transcript && transcript.trim().length > 0) {
                  // Registrar la primera vez que recibimos transcripción para métricas
                  if (!this.hasReceivedTranscription) {
                    this.hasReceivedTranscription = true;
                    this.metrics.audioToFirstTranscription =
                      Date.now() - this.firstAudioReceivedTime;
                    console.log(
                      `🎤 [ASR] 🎙️ Primera transcripción en: ${this.metrics.audioToFirstTranscription}ms`
                    );
                  }

                  // Actualizar si el texto ha cambiado
                  const hasTextChanged =
                    transcript !== this.lastPartialTranscript;
                  if (hasTextChanged) {
                    this.lastPartialTranscript = transcript;
                    this.lastTranscriptUpdateTime = Date.now(); // Actualizar timestamp

                    // Solo mostrar logs para cambios significativos
                    if (
                      result.IsPartial === false ||
                      this.debugger.logLevel !== "minimal"
                    ) {
                      console.log(
                        `🎤 [ASR] 📝 Texto: "${transcript.substring(0, 100)}${
                          transcript.length > 100 ? "..." : ""
                        }"`
                      );
                    }
                  }

                  if (result.IsPartial === true) {
                    const accumulated = this.accumulateText(transcript, true);
                    this.emitter.emit("partial-transcript", {
                      text: accumulated || "",
                      confidence: confidence,
                    });
                  } else {
                    // Transcripción final para este segmento
                    const accumulated = this.accumulateText(transcript, false);

                    // Log para segmentos completos
                    if (this.debugger.logLevel !== "minimal") {
                      console.log(
                        `🎤 [ASR] ✓ Segmento completo: "${transcript.substring(
                          0,
                          100
                        )}${transcript.length > 100 ? "..." : ""}"`
                      );
                    }

                    this.emitter.emit("segment-transcript", {
                      text: transcript,
                      confidence: confidence,
                    });
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      const err = error as Error;
      console.error(`🎤 [ASR] ❌ ERROR: ${err.message}`);
    } finally {
      // Asegurarnos de que isStreaming se actualice correctamente
      this.isStreaming = false;

      // Si estamos en estado completo, emitir inmediatamente el resultado final
      if (this.state === "Complete" && !this.hasSentFinalTranscript) {
        // Intentar un reintento adicional solo si hay una transcripción en curso
        // que no ha terminado completamente
        if (
          this.accumulatedText.length > 0 &&
          this.finalTranscriptionAttempts < this.MAX_FINAL_ATTEMPTS
        ) {
          this.finalTranscriptionAttempts++;
          console.log(
            `🎤 [ASR] 🔄 Reintentando transcripción final (intento ${this.finalTranscriptionAttempts}/${this.MAX_FINAL_ATTEMPTS})`
          );
          this.startTranscription();
        } else {
          // Emitir el evento final sin más retrasos
          this.emitFinalTranscriptNow();
        }
      }
    }
  }

  // Método para finalizar la transcripción
  finishTranscription() {
    // Evitar múltiples finalizaciones
    if (this.state === "Complete") {
      return;
    }

    this.state = "Complete";

    // Calcular tiempo total de procesamiento para métricas
    if (this.processingStartTime > 0) {
      this.metrics.totalProcessingTime = Date.now() - this.processingStartTime;
    }

    // Finalizar solo si tenemos datos acumulados significativos
    if (this.audioBuffer.length > 0 && this.accumulatedText.length > 0) {
      console.log(
        `🎤 [ASR] 🎯 Finalizando con texto: "${this.accumulatedText.substring(
          0,
          100
        )}${this.accumulatedText.length > 100 ? "..." : ""}"`
      );

      // Añadir un "frame de finalización" para ayudar a AWS
      const silenceFrame = Buffer.alloc(640, 128); // Frame más grande
      this.audioBuffer.push(this.convertMuLawToPCM(silenceFrame));

      // Hacer una última transcripción si es necesario
      if (!this.isStreaming) {
        this.startTranscription();
      } else {
        // Si ya hay una transcripción en curso, esperamos a que termine
        // y la lógica en finally de startTranscription manejará el final
        console.log(
          `🎤 [ASR] ⏱️ Esperando a que termine la transcripción en curso...`
        );

        // Establecer un timeout por si acaso la transcripción no termina
        setTimeout(() => {
          if (!this.hasSentFinalTranscript) {
            console.log(`🎤 [ASR] ⏱️ Forzando finalización de transcripción`);
            this.emitFinalTranscriptNow();
          }
        }, 800);
      }
    } else {
      // No hay audio que transcribir o texto acumulado
      console.log(`🎤 [ASR] 🔇 Finalizando sin texto (silencio o error)`);
      this.emitFinalTranscriptAndReset("", 0);

      // Detener verificadores de inactividad
      this.stopInactivityCheck();
    }

    // Mostrar métricas de rendimiento
    this.logMetrics();
  }

  // Método para mostrar métricas de rendimiento
  private logMetrics() {
    if (this.metrics.audioToFirstTranscription > 0) {
      console.log(
        `🎤 [ASR] 📊 Tiempo hasta primera transcripción: ${this.metrics.audioToFirstTranscription}ms`
      );
    }
    if (this.metrics.totalProcessingTime > 0) {
      console.log(
        `🎤 [ASR] 📊 Tiempo total de procesamiento: ${this.metrics.totalProcessingTime}ms`
      );
    }
  }

  // Método para emitir inmediatamente el evento final
  private emitFinalTranscriptNow() {
    // Evitar emitir múltiples veces
    if (this.hasSentFinalTranscript) {
      return;
    }

    this.hasSentFinalTranscript = true;

    // Detener verificadores de inactividad
    this.stopInactivityCheck();

    // Emitir el evento con la transcripción completa
    this.emitFinalTranscriptAndReset(this.accumulatedText, 0.9);
  }

  /*
   * Convierte audio PCMU (μ-law) a PCM para AWS Transcribe
   */
  private convertMuLawToPCM(muLawData: Uint8Array): Buffer {
    const pcmBuffer = Buffer.alloc(muLawData.length * 2);

    // Tabla de conversión μ-law a PCM (aproximada)
    const MULAW_BIAS = 33;
    const MULAW_CLIP = 32635;

    for (let i = 0; i < muLawData.length; i++) {
      const mulaw = muLawData[i];
      let sample = ~mulaw;

      // Extraer y procesar el valor
      const sign = sample & 0x80 ? -1 : 1;
      sample &= 0x7f;

      // Convertir a PCM
      let magnitude = ((sample << 4) | 0x8) << (sample >> 4);
      magnitude -= MULAW_BIAS;

      // Limitar el valor para evitar desbordamiento
      const value = sign * Math.min(magnitude, MULAW_CLIP);

      pcmBuffer.writeInt16LE(value, i * 2);
    }

    return pcmBuffer;
  }

  // Método para acumular texto mejorado
  private accumulateText(transcript: string, isPartial: boolean = false) {
    transcript = transcript.trim();

    if (transcript.length === 0) {
      return this.accumulatedText;
    }

    // Si es parcial, solo actualizamos si es más largo o más informativo
    if (isPartial) {
      if (
        transcript.length > this.accumulatedText.length ||
        (transcript.length >= 10 && !this.accumulatedText.includes(transcript))
      ) {
        this.accumulatedText = transcript;
      }
      return this.accumulatedText;
    }

    // Para segmentos completos, manejar actualización de forma inteligente
    if (this.accumulatedText.length === 0) {
      this.accumulatedText = transcript;
    } else if (!this.hasSignificantOverlap(transcript, this.accumulatedText)) {
      // Si no hay superposición significativa, probablemente es una nueva parte
      if (this.accumulatedText.length < transcript.length) {
        this.accumulatedText = transcript; // Usar el nuevo si es más largo
      } else if (transcript.length > 15) {
        // Si el nuevo segmento es sustancial, considerar concatenar
        const normalized1 = this.normalizeText(this.accumulatedText);
        const normalized2 = this.normalizeText(transcript);

        if (
          !normalized1.includes(normalized2) &&
          !normalized2.includes(normalized1)
        ) {
          // Verificar si hay palabras repetidas en la juntura para evitar duplicaciones
          this.accumulatedText = this.smartConcat(
            this.accumulatedText,
            transcript
          );
        } else {
          // Usar el más largo si uno contiene al otro
          this.accumulatedText =
            normalized1.length >= normalized2.length
              ? this.accumulatedText
              : transcript;
        }
      }
    }

    return this.accumulatedText;
  }

  // Método para normalizar texto
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Método para concatenar texto de forma inteligente evitando duplicaciones
  private smartConcat(text1: string, text2: string): string {
    // Dividir en palabras
    const words1 = text1.split(/\s+/);
    const words2 = text2.split(/\s+/);

    // Buscar la mejor superposición en la juntura
    let bestOverlap = 0;
    let overlapIndex = 0;

    for (let i = 1; i <= Math.min(words1.length, words2.length, 5); i++) {
      const endOfText1 = words1
        .slice(words1.length - i)
        .join(" ")
        .toLowerCase();
      const startOfText2 = words2.slice(0, i).join(" ").toLowerCase();

      if (endOfText1 === startOfText2 && i > bestOverlap) {
        bestOverlap = i;
        overlapIndex = i;
      }
    }

    // Concatenar con la superposición adecuada
    if (bestOverlap > 0) {
      return text1 + " " + words2.slice(overlapIndex).join(" ");
    } else {
      return text1 + " " + text2;
    }
  }

  // Método para detectar superposición mejorado
  private hasSignificantOverlap(text1: string, text2: string): boolean {
    // Normalizar los textos
    const norm1 = this.normalizeText(text1);
    const norm2 = this.normalizeText(text2);

    // Considerar superposición si uno contiene al otro
    if (norm2.includes(norm1) || norm1.includes(norm2)) {
      return true;
    }

    // O si hay una superposición significativa de palabras
    const words1 = norm1.split(/\s+/);
    const words2 = norm2.split(/\s+/);

    // Contar palabras comunes
    const commonWords = words1.filter(
      (word) => words2.includes(word) && word.length > 3
    );

    // Si hay al menos 3 palabras sustanciales en común o más del 50% de superposición
    return (
      commonWords.length >= 3 ||
      commonWords.length / Math.min(words1.length, words2.length) > 0.5
    );
  }

  // Método para emitir el evento final
  private emitFinalTranscriptAndReset(transcript: string, confidence: number) {
    // Usar la transcripción acumulada si existe, o la proporcionada si no
    const finalText =
      this.accumulatedText.length > 0 ? this.accumulatedText : transcript;

    // Emitir el evento de transcripción final
    console.log(`🎤 [ASR] ✅ FINAL: "${finalText}"`);
    console.log(`🎤 [ASR] 🤖 Turno del bot para responder`);

    this.emitter.emit("final-transcript", {
      text: finalText || "",
      confidence: confidence,
    });

    // Resetear acumulación de texto para evitar duplicaciones
    this.resetAccumulation();
  }

  // Métodos de prueba simplificados
  public sendTestAudio(): void {
    this.sendTestAudioFile();
  }

  public sendTestAudioFile(): void {
    console.log("🎤 [ASR] Enviando audio de prueba desde archivo");

    const fs = require("fs");
    const path = require("path");

    try {
      const testAudioPath = path.join(__dirname, "../../test-audio.pcm");
      if (fs.existsSync(testAudioPath)) {
        const audioData = fs.readFileSync(testAudioPath);
        const audioBuffer = Buffer.from(audioData);

        const chunkSize = 1600;
        for (let i = 0; i < audioBuffer.length; i += chunkSize) {
          const chunk = audioBuffer.slice(i, i + chunkSize);
          setTimeout(() => {
            this.processAudio(new Uint8Array(chunk));
          }, (i / chunkSize) * 100);
        }

        console.log(
          `🎤 [ASR] Cargado audio de prueba (${audioBuffer.length} bytes)`
        );
      } else {
        console.log("🎤 [ASR] No se encontró archivo de prueba");
      }
    } catch (err) {
      console.error("🎤 [ASR] Error cargando audio de prueba");
    }
  }
}

export class Transcript {
  text: string;
  confidence: number;

  constructor(text: string, confidence: number) {
    this.text = text;
    this.confidence = confidence;
  }
}

// Sistema de depuración para el ASR - SIMPLIFICADO
export class ASRDebugger {
  private static instance: ASRDebugger;
  private isEnabled: boolean = false;
  private transcriptionHistory: {
    timestamp: Date;
    type: string;
    text: string;
    confidence: number;
  }[] = [];
  public logLevel: "minimal" | "normal" | "verbose" = "minimal";

  private constructor() {}

  static getInstance(): ASRDebugger {
    if (!ASRDebugger.instance) {
      ASRDebugger.instance = new ASRDebugger();
    }
    return ASRDebugger.instance;
  }

  enable(level: "minimal" | "normal" | "verbose" = "minimal"): void {
    this.isEnabled = true;
    this.logLevel = level;
    console.log(`🎤 [ASR] Habilitado (nivel: ${this.logLevel})`);
  }

  disable(): void {
    this.isEnabled = false;
    console.log("🎤 [ASR] Deshabilitado");
  }

  // Método simplificado para logs, principalmente para compatibilidad
  logEvent(type: string, data: any): void {
    if (!this.isEnabled || this.logLevel === "minimal") return;

    // Solo imprimir errores y problemas críticos
    if (type === "error" || type === "transcribe-error") {
      console.error(
        `🎤 [ASR] ❌ ERROR: ${
          typeof data === "string" ? data : JSON.stringify(data)
        }`
      );
    }
  }

  getTranscriptionHistory(): {
    timestamp: Date;
    type: string;
    text: string;
    confidence: number;
  }[] {
    return [...this.transcriptionHistory];
  }

  clearHistory(): void {
    this.transcriptionHistory = [];
  }
}

// Función auxiliar para actualizar Session
export function updateSessionForUserTurn(session: any) {
  if (session && session.asr) {
    session.asr.resetForUserTurn();
    console.log("🤖 Turno del usuario - ASR reiniciado");
  }
}
