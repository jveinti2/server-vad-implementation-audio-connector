import { v4 as uuid } from "uuid";
import { ASRService } from "./asr-service";
import { VADASRService } from "./vad-asr-service";
import { TTSService } from "./tts-service";
import { UserSession } from "../interfaces/user-session";

/**
 * Servicio para gestionar las sesiones de usuario
 */
export class SessionService {
  private sessions: Map<string, UserSession> = new Map();

  /**
   * Crea una nueva sesión de usuario
   * @param userId ID del usuario
   * @param useVAD Si debe usar VAD en lugar de timeouts
   * @returns La sesión creada
   */
  createSession(userId: string, useVAD: boolean = false): UserSession {
    console.log(
      `🔄 [Session] Creando sesión para usuario: ${userId} ${
        useVAD ? "con VAD" : "sin VAD"
      }`
    );

    // Crear servicios de audio
    const tts = new TTSService();
    // Usar VAD-ASR o ASR normal según la opción
    const asr = useVAD ? new VADASRService() : new ASRService();

    // Crear la sesión
    const sessionId = uuid();
    const session: UserSession = {
      id: sessionId,
      userId,
      asr,
      tts,
      createdAt: new Date(),
      usesVAD: useVAD,
    };

    // Guardar en el mapa
    this.sessions.set(sessionId, session);
    console.log(`✅ [Session] Sesión ${sessionId} creada exitosamente`);

    return session;
  }

  /**
   * Obtiene una sesión por su ID
   * @param sessionId ID de la sesión
   * @returns La sesión si existe, o undefined
   */
  getSession(sessionId: string): UserSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Obtiene todas las sesiones de un usuario
   * @param userId ID del usuario
   * @returns Array de sesiones
   */
  getUserSessions(userId: string): UserSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.userId === userId
    );
  }

  /**
   * Elimina una sesión
   * @param sessionId ID de la sesión a eliminar
   * @returns true si se eliminó, false si no existía
   */
  removeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Obtiene el número de sesiones activas
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
