// src/services/llm/llm-provider.interface.ts
import { EventEmitter } from "events";

export interface ConversationContext {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  metadata?: Record<string, any>;
}

export interface LLMResponse {
  text: string;
  confidence: number;
  metadata?: Record<string, any>;
}

// Respuesta parcial durante streaming
export interface PartialResponse {
  text: string;
  final: boolean;
}

export interface LLMProvider extends EventEmitter {
  // Método para enviar una transcripción completa y obtener respuesta
  generateResponse(
    input: string,
    context: ConversationContext
  ): Promise<LLMResponse>;

  // Método opcional para futuro soporte de streaming (los proveedores pueden no implementarlo)
  supportsStreaming(): boolean;

  // Método para reiniciar/limpiar el contexto si es necesario
  resetContext(sessionId: string): void;
}
