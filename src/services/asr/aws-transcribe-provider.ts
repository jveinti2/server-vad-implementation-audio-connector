import {
  BaseTranscribeProvider,
  Transcript,
  TranscribeProviderState,
} from "./transcribe-provider.interface";
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  AudioStream,
  TranscriptEvent,
  Result,
} from "@aws-sdk/client-transcribe-streaming";
import { Readable } from "stream";

/**
 * Implementación del proveedor de transcripción usando AWS Transcribe
 */
export class AWSTranscribeProvider extends BaseTranscribeProvider {
  private transcribeClient: TranscribeStreamingClient;
  private audioStream: any;
  private activeStream: any | null = null;
  private accumulator: Accumulator;
  private lastTranscriptUpdateTime = Date.now();
  private firstAudioReceivedTime = 0;
  private readonly INACTIVITY_TIMEOUT_MS = 1500; // 1.5 segundos sin cambios
  private readonly MAX_DURATION_MS = 15000; // 15 segundos máximo
  private inactivityCheckIntervalId: NodeJS.Timeout | null = null;
  private maxDurationTimeoutId: NodeJS.Timeout | null = null;
  private processingStartTime = 0;
  private hasSentFinalTranscript = false;
  private testAudioSource: Readable | null = null;
  private activeCommands: Set<string> = new Set();

  // Métricas
  private metrics = {
    audioToFirstTranscription: 0,
    totalProcessingTime: 0,
  };

  constructor(region?: string) {
    super();
    this.transcribeClient = new TranscribeStreamingClient({
      region: region || process.env.AWS_REGION || "us-west-2",
    });
    this.audioStream = this.createAudioStream();
    this.accumulator = new Accumulator();
    this.startInactivityCheck();
  }

  /**
   * Inicia el verificador de inactividad
   */
  private startInactivityCheck(): void {
    // Limpiar timers previos
    this.stopInactivityCheck();

    // Configurar timeout máximo
    this.maxDurationTimeoutId = setTimeout(() => {
      if (this.isState("Processing") && !this.hasSentFinalTranscript) {
        console.log(
          `🎤 [AWS] ⏱️ Tiempo máximo alcanzado (${
            this.MAX_DURATION_MS / 1000
          }s) - Finalizando transcripción`
        );
        this.finishTranscription();
      }
    }, this.MAX_DURATION_MS);

    // Configurar verificador de inactividad
    this.inactivityCheckIntervalId = setInterval(() => {
      if (this.isState("Processing") && !this.hasSentFinalTranscript) {
        const timeSinceLastUpdate = Date.now() - this.lastTranscriptUpdateTime;

        // Solo mostrar log cada segundo para no saturar
        if (timeSinceLastUpdate > 1000 && timeSinceLastUpdate % 1000 < 250) {
          console.log(
            `🎤 [AWS] ⏱️ ${
              Math.round(timeSinceLastUpdate / 100) / 10
            }s sin cambios (umbral: ${this.INACTIVITY_TIMEOUT_MS / 1000}s)`
          );
        }

        if (timeSinceLastUpdate > this.INACTIVITY_TIMEOUT_MS) {
          console.log(
            `🎤 [AWS] ⏱️ Inactividad detectada tras ${
              this.INACTIVITY_TIMEOUT_MS / 1000
            }s - Finalizando transcripción`
          );
          this.finishTranscription();
        }
      }
    }, 250);
  }

  /**
   * Detiene el verificador de inactividad
   */
  private stopInactivityCheck(): void {
    if (this.inactivityCheckIntervalId) {
      clearInterval(this.inactivityCheckIntervalId);
      this.inactivityCheckIntervalId = null;
    }

    if (this.maxDurationTimeoutId) {
      clearTimeout(this.maxDurationTimeoutId);
      this.maxDurationTimeoutId = null;
    }
  }

  /**
   * Reinicia el proveedor para un nuevo turno
   */
  reset(): void {
    super.reset();
    this.lastTranscriptUpdateTime = Date.now();
    this.processingStartTime = 0;
    this.firstAudioReceivedTime = 0;
    this.accumulator.reset();
    this.hasSentFinalTranscript = false;
    this.audioStream = this.createAudioStream();
    this.activeCommands.clear();
    this.metrics = {
      audioToFirstTranscription: 0,
      totalProcessingTime: 0,
    };

    // Cerrar stream de test si existe
    if (this.testAudioSource) {
      this.testAudioSource.destroy();
      this.testAudioSource = null;
    }

    // Reiniciar verificador de inactividad
    this.startInactivityCheck();
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
   * Crea un stream de audio
   */
  private createAudioStream() {
    // Crear un buffer y manejadores para el stream
    let buffer = new Uint8Array();
    let resolvers: ((value: Uint8Array | null) => void)[] = [];
    let rejects: ((reason?: any) => void)[] = [];

    // Objeto con método handle que será llamado desde processAudio
    const streamInterface = {
      handle: (chunk: Uint8Array | null) => {
        if (chunk && chunk.length > 0) {
          buffer = Uint8Array.from([...buffer, ...chunk]);
        } else if (chunk === null) {
          // Final de stream
          for (const resolve of resolvers) {
            resolve(null);
          }
          resolvers = [];
          return;
        }

        for (const resolve of resolvers) {
          const data = buffer;
          buffer = new Uint8Array();
          resolve(data);
        }
        resolvers = [];
      },
    };

    // Función generadora para AWS Transcribe
    const generator = async function* () {
      while (true) {
        if (buffer.length > 0) {
          const data = buffer;
          buffer = new Uint8Array();
          yield { AudioEvent: { AudioChunk: data } };
        } else {
          const chunk = await new Promise<Uint8Array | null>(
            (resolve, reject) => {
              resolvers.push(resolve);
              rejects.push(reject);
            }
          );

          if (chunk === null) {
            return; // Fin del stream
          }

          if (chunk.length > 0) {
            yield { AudioEvent: { AudioChunk: chunk } };
          }
        }
      }
    };

    // Combinar la interfaz con el generador
    const combined = generator as any;
    combined.handle = streamInterface.handle;

    return combined;
  }

  /**
   * Procesa un chunk de audio
   */
  processAudio(data: Uint8Array): void {
    if (this.isState("Complete")) {
      return;
    }

    // Verificar si hay datos de audio válidos
    if (!data || data.length === 0) {
      console.log(`🎤 [AWS] ⚠️ Recibido chunk de audio vacío`);
      return;
    }

    // Registrar tiempo del primer audio
    if (this.firstAudioReceivedTime === 0) {
      this.firstAudioReceivedTime = Date.now();
      console.log(`🎤 [AWS] 🎙️ Primer audio recibido: ${data.length} bytes`);
    }

    // Inicializar estado si es necesario
    if (this.state === "None") {
      this.startTranscription();
    }

    // Enviar audio al stream de forma segura
    try {
      if (this.audioStream && typeof this.audioStream.handle === "function") {
        this.audioStream.handle(data);
      } else {
        console.error(
          `🎤 [AWS] ❌ Error: audioStream.handle no es una función`
        );
        this.emitter.emit(
          "error",
          new Error("audioStream.handle no es una función")
        );
      }
    } catch (error) {
      console.error(`🎤 [AWS] ❌ Error al procesar audio: ${error}`);
      this.emitter.emit("error", error);
    }
  }

  /**
   * Inicia el proceso de transcripción
   */
  private startTranscription(): void {
    if (this.isState("Processing")) {
      return;
    }

    console.log(`🎤 [AWS] 🔄 Iniciando transcripción`);

    try {
      // Verificar que el audioStream está correctamente inicializado
      if (!this.audioStream || typeof this.audioStream !== "function") {
        console.log(`🎤 [AWS] ⚠️ Recreando audioStream`);
        this.audioStream = this.createAudioStream();
      }

      this.state = "Processing";
      this.processingStartTime = Date.now();
      this.lastTranscriptUpdateTime = Date.now();

      // Crear comando de transcripción
      const command = new StartStreamTranscriptionCommand({
        LanguageCode: "es-ES",
        MediaSampleRateHertz: 44100,
        MediaEncoding: "pcm",
        AudioStream: this.audioStream(),
      });

      // Rastrear comando para debugging
      const commandId = Math.random().toString(36).substring(7);
      this.activeCommands.add(commandId);
      console.log(`🎤 [AWS] 🔄 Comando ${commandId} iniciado`);

      // Iniciar transcripción
      this.transcribeClient
        .send(command)
        .then(async (response) => {
          console.log(`🎤 [AWS] 🔄 Iniciando procesamiento de eventos`);
          const events = response.TranscriptResultStream;

          try {
            if (events) {
              for await (const event of events) {
                if (this.isState("Complete")) {
                  break;
                }
                // Verificar que el evento es del tipo correcto
                if ("Transcript" in event) {
                  this.processTranscriptEvent(event as TranscriptEvent);
                }
              }
            }
          } catch (error) {
            if (this.isState("Complete")) {
              // Ignorar errores cuando ya completamos
              return;
            }
            console.error(`🎤 [AWS] ❌ Error procesando eventos: ${error}`);
            this.emitter.emit("error", error);
          } finally {
            this.activeCommands.delete(commandId);
            console.log(`🎤 [AWS] 🔄 Comando ${commandId} finalizado`);

            // Si es el último comando y estamos en estado complete, emitir final
            if (
              this.activeCommands.size === 0 &&
              this.isState("Complete") &&
              !this.hasSentFinalTranscript
            ) {
              this.emitFinalTranscript();
            }
          }
        })
        .catch((error) => {
          this.activeCommands.delete(commandId);
          if (this.isState("Complete")) {
            // Ignorar errores cuando ya completamos
            return;
          }
          console.error(`🎤 [AWS] ❌ Error iniciando transcripción: ${error}`);
          this.emitter.emit("error", error);

          // Reintentar con un nuevo audioStream si es un error de stream
          if (error.message && error.message.includes("stream")) {
            console.log(`🎤 [AWS] 🔄 Reintentando con nuevo audioStream`);
            this.audioStream = this.createAudioStream();
            setTimeout(() => {
              if (!this.isState("Complete")) {
                this.state = "None"; // Volver a None para permitir reinicio
                this.startTranscription();
              }
            }, 1000);
          }
        });
    } catch (error) {
      console.error(`🎤 [AWS] ❌ Error preparando transcripción: ${error}`);
      this.emitter.emit("error", error);
    }
  }

  /**
   * Procesa eventos de transcripción de AWS
   */
  private processTranscriptEvent(event: TranscriptEvent): void {
    // Manejar eventos por tipo
    if (event.Transcript?.Results) {
      const results = event.Transcript.Results;

      for (const result of results) {
        // Si es final o es parcial con alternativas
        if (
          (result.IsPartial === false ||
            (result.IsPartial === true && result.Alternatives?.length)) &&
          result.Alternatives?.[0]
        ) {
          const transcript = result.Alternatives[0].Transcript || "";
          const isPartial = result.IsPartial || false;

          if (transcript && transcript.trim().length > 0) {
            // Actualizar timestamp para inactividad
            this.lastTranscriptUpdateTime = Date.now();

            // Registrar tiempo hasta primera transcripción
            if (
              this.metrics.audioToFirstTranscription === 0 &&
              this.firstAudioReceivedTime > 0
            ) {
              this.metrics.audioToFirstTranscription =
                Date.now() - this.firstAudioReceivedTime;
              console.log(
                `🎤 [AWS] 🎙️ Primera transcripción en: ${this.metrics.audioToFirstTranscription}ms`
              );
            }

            // Acumular texto
            this.accumulator.addTranscript(result);

            // Emitir transcripción parcial
            const accumulatedText = this.accumulator.getCurrentText();
            console.log(
              `🎤 [AWS] 📝 ${isPartial ? "Parcial" : "Final"}: "${transcript}"`
            );
            console.log(`🎤 [AWS] 📝 Acumulado: "${accumulatedText}"`);

            this.emitter.emit("partial-transcript", {
              text: accumulatedText,
              confidence: parseFloat(
                result.Alternatives[0].Items?.[0]?.Confidence?.toString() || "0"
              ),
            });
          }
        }
      }
    }
  }

  /**
   * Finaliza la transcripción
   */
  finishTranscription(): void {
    if (this.isState("Complete")) {
      return;
    }

    console.log(`🎤 [AWS] 🔄 Finalizando transcripción`);
    this.state = "Complete";

    // Calcular tiempo total de procesamiento
    if (this.processingStartTime > 0) {
      this.metrics.totalProcessingTime = Date.now() - this.processingStartTime;
    }

    // Detener verificadores
    this.stopInactivityCheck();

    // Añadir último buffer vacío para indicar final de stream
    try {
      if (this.audioStream && typeof this.audioStream.handle === "function") {
        this.audioStream.handle(null);
        console.log(`🎤 [AWS] 🔄 Enviada señal de finalización al stream`);
      } else {
        console.log(
          `🎤 [AWS] ⚠️ No se pudo enviar señal de finalización al stream`
        );
      }
    } catch (error) {
      console.error(`🎤 [AWS] ❌ Error al finalizar el stream: ${error}`);
    }

    // Si no hay comandos activos, emitir final
    if (this.activeCommands.size === 0 && !this.hasSentFinalTranscript) {
      this.emitFinalTranscript();
    }
    // Si hay comandos activos, se emitirá cuando terminen
  }

  /**
   * Emite la transcripción final
   */
  private emitFinalTranscript(): void {
    if (this.hasSentFinalTranscript) {
      return;
    }

    this.hasSentFinalTranscript = true;

    // Mostrar métricas
    this.logMetrics();

    // Obtener texto acumulado
    const finalText = this.accumulator.getCurrentText();

    // Si no tenemos texto acumulado, emitir vacío
    if (finalText.length === 0) {
      console.log(`🎤 [AWS] 🔇 Sin texto final (silencio o error)`);
      this.emitter.emit("final-transcript", {
        text: "",
        confidence: 0,
      });
      return;
    }

    // Emitir transcripción final
    console.log(`🎤 [AWS] ✅ FINAL: "${finalText}"`);
    console.log(`🎤 [AWS] 🤖 Turno del bot para responder`);

    this.emitter.emit("final-transcript", {
      text: finalText,
      confidence: 0.9,
    });
  }

  /**
   * Muestra las métricas de rendimiento
   */
  private logMetrics(): void {
    if (this.metrics.audioToFirstTranscription > 0) {
      console.log(
        `🎤 [AWS] 📊 Tiempo hasta primera transcripción: ${this.metrics.audioToFirstTranscription}ms`
      );
    }
    if (this.metrics.totalProcessingTime > 0) {
      console.log(
        `🎤 [AWS] 📊 Tiempo total de procesamiento: ${this.metrics.totalProcessingTime}ms`
      );
    }
  }

  /**
   * Envía audio de prueba al proveedor
   */
  sendTestAudio(testAudioPath: string): void {
    if (this.isState("Complete")) {
      return;
    }

    const fs = require("fs");
    const path = require("path");

    try {
      // Validar path
      const resolvedPath = path.resolve(testAudioPath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Archivo no encontrado: ${resolvedPath}`);
      }

      console.log(`🎤 [AWS] 🧪 Enviando audio de prueba: ${resolvedPath}`);

      // Crear stream para leer el archivo
      this.testAudioSource = fs.createReadStream(resolvedPath);
      const audioSource = this.testAudioSource;

      // Iniciar transcripción si no está iniciada
      if (this.state === "None") {
        this.startTranscription();
      }

      // Procesar audio en chunks
      if (audioSource) {
        audioSource.on("data", (chunk: Buffer) => {
          this.processAudio(new Uint8Array(chunk));
        });

        audioSource.on("end", () => {
          console.log(`🎤 [AWS] 🧪 Fin de audio de prueba`);
          setTimeout(() => this.finishTranscription(), 1000);
        });

        audioSource.on("error", (error: Error) => {
          console.error(`🎤 [AWS] ❌ Error leyendo audio de prueba: ${error}`);
          this.emitter.emit("error", error);
        });
      } else {
        console.error(`🎤 [AWS] ❌ No se pudo crear stream de audio`);
        this.emitter.emit(
          "error",
          new Error("No se pudo crear stream de audio")
        );
      }
    } catch (error) {
      console.error(`🎤 [AWS] ❌ Error con audio de prueba: ${error}`);
      this.emitter.emit("error", error);
    }
  }
}

/**
 * Clase auxiliar para manejar la acumulación de transcripciones
 */
class Accumulator {
  private items: Map<string, TranscriptItem> = new Map();
  private stable: string[] = [];

  reset() {
    this.items.clear();
    this.stable = [];
  }

  addTranscript(result: Result) {
    // Si no es parcial, marcar como estable
    if (result.IsPartial === false) {
      const alt = result.Alternatives?.[0];
      if (alt?.Transcript) {
        this.stable.push(alt.Transcript);
      }
      return;
    }

    const id = result.ResultId;
    if (!id) return;

    const alt = result.Alternatives?.[0];
    if (!alt) return;

    // Guardar en mapa con su ID
    this.items.set(id, {
      id,
      transcript: alt.Transcript || "",
      isPartial: result.IsPartial || true,
      startTime: result.StartTime,
      endTime: result.EndTime,
    });
  }

  getCurrentText(): string {
    // Combinar texto estable con parciales ordenados
    const stable = this.stable.join(" ");
    const partial = Array.from(this.items.values())
      .filter((item) => item.transcript && item.transcript.trim().length > 0)
      .sort((a, b) => {
        // Ordenar por tiempo de inicio si disponible
        if (a.startTime && b.startTime) {
          return a.startTime - b.startTime;
        }
        // Fallback a orden de ID
        return a.id.localeCompare(b.id);
      })
      .map((item) => item.transcript)
      .join(" ");

    let text = stable;
    if (partial) {
      text = text ? `${text} ${partial}` : partial;
    }

    return text.trim();
  }
}

/**
 * Tipo de item de transcripción para el acumulador
 */
interface TranscriptItem {
  id: string;
  transcript: string;
  isPartial: boolean;
  startTime?: number;
  endTime?: number;
}
