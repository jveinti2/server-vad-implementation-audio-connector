import { EventEmitter } from "events";

/**
 * Interfaz para la transcripción de audio
 */
export interface Transcript {
  text: string;
  confidence: number;
}

/**
 * Estados posibles del proveedor de transcripción
 */
export type TranscribeProviderState = "None" | "Processing" | "Complete";

/**
 * Interfaz para proveedores de transcripción de voz
 */
export interface TranscribeProvider {
  /**
   * Procesa datos de audio para transcripción
   */
  processAudio(data: Uint8Array): Promise<void> | void;

  /**
   * Finaliza la transcripción actual
   */
  finishTranscription(): Promise<void> | void;

  /**
   * Reinicia el proveedor para un nuevo turno de usuario
   */
  reset(): void;

  /**
   * Devuelve el estado actual del proveedor
   */
  getState(): TranscribeProviderState;

  /**
   * Devuelve las métricas de rendimiento
   */
  getMetrics(): { [key: string]: number };

  /**
   * Registra manejadores de eventos para los diferentes tipos de transcripción
   */
  on(
    event:
      | "error"
      | "partial-transcript"
      | "segment-transcript"
      | "final-transcript",
    listener: (data: any) => void
  ): TranscribeProvider;
}

/**
 * Clase base abstracta para proveedores de transcripción
 */
export abstract class BaseTranscribeProvider implements TranscribeProvider {
  protected emitter = new EventEmitter();
  protected state: TranscribeProviderState = "None";

  abstract processAudio(data: Uint8Array): Promise<void> | void;
  abstract finishTranscription(): Promise<void> | void;

  getState(): TranscribeProviderState {
    return this.state;
  }

  /**
   * Comprueba si el estado es igual al estado especificado
   */
  protected isState(state: TranscribeProviderState): boolean {
    return this.state === state;
  }

  getMetrics(): { [key: string]: number } {
    return {};
  }

  reset(): void {
    this.state = "None";
  }

  on(event: string, listener: (data: any) => void): TranscribeProvider {
    this.emitter.addListener(event, listener);
    return this;
  }
}
