import { ASRService } from "../services/asr-service";
import { VADASRService } from "../services/vad-asr-service";
import { TTSService } from "../services/tts-service";

/**
 * Interfaz que define la estructura de una sesión de usuario
 */
export interface UserSession {
  /**
   * ID único de la sesión
   */
  id: string;

  /**
   * ID del usuario asociado
   */
  userId: string;

  /**
   * Servicio ASR (reconocimiento de voz)
   */
  asr: ASRService | VADASRService;

  /**
   * Servicio TTS (síntesis de voz)
   */
  tts: TTSService;

  /**
   * Timestamp de creación
   */
  createdAt: Date;

  /**
   * Indica si usa VAD
   */
  usesVAD: boolean;

  /**
   * Datos adicionales de la sesión
   */
  [key: string]: any;
}
