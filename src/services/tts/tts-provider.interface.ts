import { EventEmitter } from "events";

/**
 * Opciones para la síntesis de voz
 */
export interface TTSOptions {
  voiceId?: string;
  engine?: string;
  textType?: string;
  sampleRate?: string;
  model?: string;
  format?: string;
  speed?: number;
}

/**
 * Estados posibles del proveedor de síntesis de voz
 */
export type TTSProviderState = "None" | "Processing" | "Complete";

/**
 * Interfaz para proveedores de síntesis de voz
 */
export interface TTSProvider {
  /**
   * Sintetiza texto a voz
   */
  synthesizeSpeech(text: string, options?: TTSOptions): Promise<Uint8Array>;

  /**
   * Reinicia el proveedor para una nueva síntesis
   */
  reset(): void;

  /**
   * Devuelve el estado actual del proveedor
   */
  getState(): TTSProviderState;

  /**
   * Devuelve las métricas de rendimiento
   */
  getMetrics(): { [key: string]: number };

  /**
   * Registra manejadores de eventos para los diferentes eventos de síntesis
   */
  on(
    event: "error" | "synthesis-start" | "synthesis-complete",
    listener: (data: any) => void
  ): TTSProvider;

  /**
   * Elimina todos los listeners registrados
   */
  removeAllListeners(): void;
}

/**
 * Clase base abstracta para proveedores de síntesis de voz
 */
export abstract class BaseTTSProvider implements TTSProvider {
  protected emitter = new EventEmitter();
  protected state: TTSProviderState = "None";

  abstract synthesizeSpeech(
    text: string,
    options?: TTSOptions
  ): Promise<Uint8Array>;

  getState(): TTSProviderState {
    return this.state;
  }

  /**
   * Comprueba si el estado es igual al estado especificado
   */
  protected isState(state: TTSProviderState): boolean {
    return this.state === state;
  }

  getMetrics(): { [key: string]: number } {
    return {};
  }

  reset(): void {
    this.state = "None";
  }

  on(event: string, listener: (data: any) => void): TTSProvider {
    this.emitter.addListener(event, listener);
    return this;
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
