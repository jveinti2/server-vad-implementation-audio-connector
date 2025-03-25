import dotenv from "dotenv";
import { Server } from "./websocket/server";
import { SessionService } from "./services/session-service";

console.log("Starting service.");

dotenv.config();
new Server().start();

// Configuración de proveedores desde variables de entorno
const useVAD =
  process.env.ASR_PROVIDER === "vad" || process.env.USE_VAD === "true";
console.log(
  `🎤 [Config] Proveedor ASR: ${
    process.env.ASR_PROVIDER || "vad (predeterminado)"
  }`
);
console.log(
  `🎤 [Config] Proveedor TTS: ${
    process.env.TTS_PROVIDER || "elevenlabs (predeterminado)"
  }`
);
console.log(
  `🎤 [Config] Proveedor LLM: ${
    process.env.LLM_PROVIDER || "openai (predeterminado)"
  }`
);

// Inicializar el servicio de sesiones
const sessionService = new SessionService();

// Crear una sesión de prueba
const testSession = sessionService.createSession("test-user", useVAD);
