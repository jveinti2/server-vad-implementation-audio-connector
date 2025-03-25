// Agregar declaración de tipos para node-vad
// @ts-ignore
import VAD from "node-vad";

import EventEmitter from "events";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import FormData from "form-data";
import axios from "axios";
import { WaveFile } from "wavefile";
import * as g711 from "g711";

/**
 * Servicio ASR que utiliza node-vad para detección de actividad de voz
 * y OpenAI Whisper para la transcripción
 */
export class VADASRService {
  private emitter = new EventEmitter();
  private state: "None" | "Processing" | "Complete" = "None";
  private vad: VAD;
  private audioBuffer: Uint8Array[] = [];
  private pcmAudioBuffer: Buffer[] = [];
  private tempFilePath: string = "";
  private debugger = ASRDebugger.getInstance();

  // Control de estado
  private isProcessing = false;
  private hasSentFinalTranscript = false;

  // Métricas
  private firstAudioReceivedTime = 0;
  private processingStartTime = 0;
  private lastTranscriptUpdateTime = 0;
  private metrics = {
    audioToFirstTranscription: 0,
    totalProcessingTime: 0,
  };

  // Acumulación de texto
  private accumulatedText = "";

  // Configuración de VAD
  private vadSpeechDetected = false;
  private vadSilenceStartTime = 0;
  // Reducirlo a 400ms para una detección más rápida (antes era 500ms)
  private readonly VAD_SILENCE_THRESHOLD_MS = 400;

  // Configuración de OpenAI
  private apiKey: string;

  constructor(apiKey?: string) {
    // Inicializar VAD con configuración agresiva para mejor detección
    this.vad = new VAD(VAD.Mode.VERY_AGGRESSIVE);

    // Obtener API key de OpenAI
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || "";

    if (!this.apiKey) {
      console.warn(
        "🎤 [VAD-ASR] ⚠️ OPENAI_API_KEY no está configurada. Las transcripciones fallarán."
      );
    }

    this.debugger.enable("minimal");
    console.log(`🎤 [VAD-ASR] 🎙️ Inicializado con OpenAI Whisper y node-vad`);
  }

  /**
   * Registra un listener para eventos del ASR
   */
  on(event: string, listener: (...args: any[]) => void): VADASRService {
    this.emitter.addListener(event, listener);
    return this;
  }

  /**
   * Devuelve el estado actual del servicio
   */
  getState(): string {
    return this.state;
  }

  /**
   * Obtiene las métricas de rendimiento
   */
  getMetrics(): {
    audioToFirstTranscription: number;
    totalProcessingTime: number;
  } {
    return { ...this.metrics };
  }

  /**
   * Reinicia el servicio ASR para un nuevo turno del usuario
   */
  resetForUserTurn(): VADASRService {
    // Limpiar estado
    this.state = "None";
    this.audioBuffer = [];
    this.pcmAudioBuffer = [];
    this.accumulatedText = "";
    this.isProcessing = false;
    this.hasSentFinalTranscript = false;
    this.firstAudioReceivedTime = 0;
    this.processingStartTime = 0;
    this.lastTranscriptUpdateTime = Date.now();
    this.vadSpeechDetected = false;
    this.vadSilenceStartTime = 0;

    // Limpiar métricas
    this.metrics = {
      audioToFirstTranscription: 0,
      totalProcessingTime: 0,
    };

    // Eliminar archivo temporal si existe
    this.cleanupTempFile();

    console.log(`🎤 [VAD-ASR] 🔄 Reiniciado para turno del usuario`);

    return this;
  }

  /**
   * Procesa un fragmento de audio
   */
  processAudio(data: Uint8Array): VADASRService {
    if (this.state === "Complete") {
      return this;
    }

    // Verificar si hay datos válidos
    if (!data || data.length === 0) {
      console.log(`🎤 [VAD-ASR] ⚠️ Chunk de audio vacío`);
      return this;
    }

    // Registrar tiempo del primer audio
    if (this.firstAudioReceivedTime === 0) {
      this.firstAudioReceivedTime = Date.now();
      console.log(
        `🎤 [VAD-ASR] 🎙️ Primer audio recibido: ${data.length} bytes`
      );
    }

    // Iniciar procesamiento si es necesario
    if (this.state === "None") {
      this.state = "Processing";
      this.processingStartTime = Date.now();
      this.lastTranscriptUpdateTime = Date.now();
    }

    // Convertir audio μ-law a PCM
    const pcmData = this.convertMuLawToPCM(data);

    // Procesar con VAD
    this.processVAD(pcmData);

    // Almacenar audio para transcripción
    this.audioBuffer.push(data);
    this.pcmAudioBuffer.push(pcmData);

    return this;
  }

  /**
   * Procesa el audio con VAD
   */
  private async processVAD(pcmData: Buffer): Promise<void> {
    try {
      // Usar 16kHz para consistencia con el formato de audio enviado a Whisper
      const vadResult = await this.vad.processAudio(pcmData, 16000);

      switch (vadResult) {
        case VAD.Event.SILENCE:
          // Si se había detectado voz antes, comenzar a contar silencio
          if (this.vadSpeechDetected) {
            const now = Date.now();

            // Iniciar contador de silencio si es necesario
            if (this.vadSilenceStartTime === 0) {
              this.vadSilenceStartTime = now;
              console.log(
                `🎤 [VAD-ASR] 🔇 Silencio detectado, comenzando contador`
              );
            }

            // Verificar si el silencio ha durado lo suficiente
            const silenceDuration = now - this.vadSilenceStartTime;

            // Log cada 500ms para no saturar la consola
            if (silenceDuration > 500 && silenceDuration % 500 < 100) {
              console.log(
                `🎤 [VAD-ASR] 🔇 Silencio durante ${silenceDuration}ms (umbral: ${this.VAD_SILENCE_THRESHOLD_MS}ms)`
              );
            }

            // Finalizar si se alcanza el umbral
            if (silenceDuration >= this.VAD_SILENCE_THRESHOLD_MS) {
              console.log(
                `🎤 [VAD-ASR] 🔇 Silencio durante ${this.VAD_SILENCE_THRESHOLD_MS}ms - Finalizando transcripción`
              );
              this.finishTranscription();
            }
          }
          break;

        case VAD.Event.VOICE:
          // Reiniciar contador de silencio
          this.vadSilenceStartTime = 0;

          // Si es la primera vez que detectamos voz
          if (!this.vadSpeechDetected) {
            this.vadSpeechDetected = true;
            console.log(`🎤 [VAD-ASR] 🎙️ Voz detectada`);
          }
          break;

        case VAD.Event.NOISE:
          // Tratar ruido como silencio, pero loguear diferente
          if (this.vadSpeechDetected && this.debugger.logLevel !== "minimal") {
            console.log(`🎤 [VAD-ASR] 🔈 Ruido detectado`);
          }
          break;
      }
    } catch (error) {
      console.error(`🎤 [VAD-ASR] ❌ Error procesando VAD: ${error}`);
    }
  }

  /**
   * Finaliza la transcripción actual
   */
  finishTranscription(): void {
    // Evitar múltiples finalizaciones
    if (this.state === "Complete") {
      return;
    }

    this.state = "Complete";

    // Calcular tiempo total de procesamiento
    if (this.processingStartTime > 0) {
      this.metrics.totalProcessingTime = Date.now() - this.processingStartTime;
    }

    // Procesar el audio acumulado con Whisper si hay suficiente
    if (this.audioBuffer.length > 0) {
      console.log(
        `🎤 [VAD-ASR] 🎯 Finalizando transcripción (${this.audioBuffer.length} chunks)`
      );

      // Iniciar transcripción de inmediato, no esperar a completar la función
      // para reducir la latencia percibida
      setTimeout(() => this.transcribeAudio(), 0);
    } else {
      console.log(`🎤 [VAD-ASR] 🔇 Finalizando sin audio (silencio o error)`);
      this.emitFinalTranscriptAndReset("", 0);
    }

    // Mostrar métricas
    this.logMetrics();
  }

  /**
   * Procesa la transcripción con OpenAI Whisper
   */
  private async transcribeAudio(): Promise<void> {
    if (this.isProcessing || this.hasSentFinalTranscript) {
      return;
    }

    this.isProcessing = true;

    try {
      if (!this.apiKey) {
        throw new Error("OPENAI_API_KEY no está configurada");
      }

      // Crear archivo temporal con audio acumulado en formato WAV correcto
      this.tempFilePath = path.join(
        os.tmpdir(),
        `whisper-audio-${Date.now()}.wav`
      );

      // Convertir PCM a WAV con wavefile
      try {
        // Concatenar buffers de audio PCM
        const pcmData = Buffer.concat(this.pcmAudioBuffer);

        // Crear un encabezado WAV correcto usando g711
        const sampleRate = 8000; // Frecuencia original de PCMU
        const audioView = new DataView(
          pcmData.buffer,
          pcmData.byteOffset,
          pcmData.byteLength
        );
        const wavBuffer = g711.encodeWAV(audioView, sampleRate, 1, 16, true);

        // Escribir el archivo WAV
        fs.writeFileSync(this.tempFilePath, Buffer.from(wavBuffer));

        console.log(
          `🎤 [VAD-ASR] 🔄 Creado archivo WAV válido: ${Math.round(
            fs.statSync(this.tempFilePath).size / 1024
          )}KB`
        );
      } catch (wavError) {
        console.error(`🎤 [VAD-ASR] ❌ Error creando archivo WAV: ${wavError}`);
        throw wavError;
      }

      console.log(
        `🎤 [VAD-ASR] 🔄 Enviando audio a Whisper (${Math.round(
          fs.statSync(this.tempFilePath).size / 1024
        )}KB)`
      );

      // Método de la documentación oficial de OpenAI
      const formData = new FormData();

      // Añadir el archivo primero (importante)
      const fileStream = fs.createReadStream(this.tempFilePath);
      formData.append("file", fileStream);

      // Añadir resto de parámetros con mejoras para precisión
      formData.append("model", "whisper-1");
      formData.append("language", "es");
      formData.append("response_format", "text"); // Simplificar a formato texto
      // No incluir prompt para evitar sesgos

      console.log("🎤 [VAD-ASR] 🔍 Enviando parámetros a OpenAI API:");
      console.log(" - model: whisper-1");
      console.log(" - language: es");
      console.log(" - response_format: text");
      console.log(
        ` - file: ${path.basename(this.tempFilePath)} (${Math.round(
          fs.statSync(this.tempFilePath).size / 1024
        )}KB)`
      );

      // Obtener los headers generados por form-data
      const formHeaders = formData.getHeaders();

      // Hacer la petición a la API según la documentación oficial
      try {
        const axiosResponse = await axios.post(
          "https://api.openai.com/v1/audio/transcriptions",
          formData,
          {
            headers: {
              ...formHeaders,
              Authorization: `Bearer ${this.apiKey}`,
            },
          }
        );

        console.log(`🎤 [VAD-ASR] API Status: ${axiosResponse.status}`);

        // Procesar respuesta en formato texto
        const transcript = axiosResponse.data.trim();

        if (transcript) {
          console.log(
            `🎤 [VAD-ASR] ✅ Transcripción recibida: "${transcript}"`
          );

          // Actualizar texto acumulado
          this.accumulatedText = transcript;

          // Registrar primera transcripción si no se ha hecho
          if (this.metrics.audioToFirstTranscription === 0) {
            this.metrics.audioToFirstTranscription =
              Date.now() - this.firstAudioReceivedTime;
          }

          // No emitir partial-transcript cuando es el final de la transcripción
          // Ya que esto causa doble respuesta del bot

          // Solo emitir final-transcript
          this.emitFinalTranscriptAndReset(transcript, 0.9);
        } else {
          console.log(`🎤 [VAD-ASR] ⚠️ No se recibió texto de Whisper`);
          this.emitFinalTranscriptAndReset("", 0);
        }
      } catch (error) {
        console.error(`🎤 [VAD-ASR] ❌ Error en la transcripción: ${error}`);

        // Mejorar el manejo de errores de Axios
        const axiosError = error as any;
        if (axios.isAxiosError(error) && axiosError.response) {
          const status = axiosError.response.status;
          console.error(
            `🎤 [VAD-ASR] ❌ Error HTTP ${status}:`,
            JSON.stringify(axiosError.response.data, null, 4)
          );
        }

        // Emitir error
        this.emitter.emit("error", error);
      }
    } catch (error) {
      console.error(`🎤 [VAD-ASR] ❌ Error transcribiendo audio: ${error}`);
      this.emitFinalTranscriptAndReset("", 0);
    } finally {
      this.isProcessing = false;
      this.cleanupTempFile();
    }
  }

  /**
   * Elimina el archivo temporal
   */
  private cleanupTempFile(): void {
    if (this.tempFilePath && fs.existsSync(this.tempFilePath)) {
      try {
        fs.unlinkSync(this.tempFilePath);
        this.tempFilePath = "";
      } catch (error) {
        console.error(
          `🎤 [VAD-ASR] ⚠️ Error eliminando archivo temporal: ${error}`
        );
      }
    }
  }

  /**
   * Muestra las métricas de rendimiento
   */
  private logMetrics(): void {
    if (this.metrics.audioToFirstTranscription > 0) {
      console.log(
        `🎤 [VAD-ASR] 📊 Tiempo hasta primera transcripción: ${this.metrics.audioToFirstTranscription}ms`
      );
    }
    if (this.metrics.totalProcessingTime > 0) {
      console.log(
        `🎤 [VAD-ASR] 📊 Tiempo total de procesamiento: ${this.metrics.totalProcessingTime}ms`
      );
    }
  }

  /**
   * Emite el evento de transcripción final
   */
  private emitFinalTranscriptAndReset(
    transcript: string,
    confidence: number
  ): void {
    // Evitar múltiples envíos
    if (this.hasSentFinalTranscript) {
      return;
    }

    this.hasSentFinalTranscript = true;

    // Usar la mejor transcripción disponible
    const finalText = transcript || this.accumulatedText || "";

    // Emitir evento
    console.log(`🎤 [VAD-ASR] ✅ FINAL: "${finalText}"`);
    console.log(`🎤 [VAD-ASR] 🤖 Turno del bot para responder`);

    // Emitir con los nombres de eventos correctos
    // IMPORTANTE: Emitimos tanto "final-transcript" (kebab-case) como "final_transcript" (snake_case)
    // para mantener compatibilidad con diferentes implementaciones

    const transcriptEvent = {
      text: finalText,
      confidence: confidence,
    };

    // Emisión kebab-case (original)
    this.emitter.emit("final-transcript", transcriptEvent);

    // Emisión snake_case (compatible con Session.ts)
    this.emitter.emit("final_transcript", transcriptEvent);
  }

  /**
   * Convierte audio PCMU (μ-law) a PCM para VAD
   */
  private convertMuLawToPCM(muLawData: Uint8Array): Buffer {
    // Usar la función correcta de g711 para convertir µ-law a PCM
    const pcmInt8 = g711.ulawToPCM(muLawData, 16);

    // Convertir Int8Array a Buffer para manipulación posterior
    const pcmBuffer = Buffer.from(pcmInt8.buffer);

    return pcmBuffer;
  }

  /**
   * Método de prueba para enviar audio desde un archivo
   */
  public sendTestAudio(): void {
    this.sendTestAudioFile();
  }

  /**
   * Envía audio de prueba desde un archivo
   */
  public sendTestAudioFile(): void {
    console.log("🎤 [VAD-ASR] Enviando audio de prueba desde archivo");

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
          `🎤 [VAD-ASR] Cargado audio de prueba (${audioBuffer.length} bytes)`
        );
      } else {
        console.log("🎤 [VAD-ASR] No se encontró archivo de prueba");
      }
    } catch (err) {
      console.error("🎤 [VAD-ASR] Error cargando audio de prueba");
    }
  }

  /**
   * Emite una transcripción parcial
   */
  private emitPartialTranscript(text: string, confidence: number): void {
    if (text) {
      const transcriptEvent = {
        text,
        confidence,
      };

      // Emitir en ambos formatos para compatibilidad
      this.emitter.emit("partial-transcript", transcriptEvent);
      this.emitter.emit("partial_transcript", transcriptEvent);

      console.log(
        `🎤 [VAD-ASR] 🔤 Parcial: "${text}" (${confidence.toFixed(2)})`
      );
    }
  }
}

// Clase del depurador, se reutiliza de ASRService
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

  // Método simplificado para logs
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

// Clase de transcripción para mantener compatibilidad
export class Transcript {
  text: string;
  confidence: number;

  constructor(text: string, confidence: number) {
    this.text = text;
    this.confidence = confidence;
  }
}
