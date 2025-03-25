import { WebSocket } from "ws";
import { JsonStringMap, MediaParameter } from "../protocol/core";
import {
  ClientMessage,
  DisconnectParameters,
  DisconnectReason,
  EventParameters,
  SelectParametersForType,
  ServerMessage,
  ServerMessageBase,
  ServerMessageType,
} from "../protocol/message";
import {
  BotTurnDisposition,
  EventEntityBargeIn,
  EventEntityBotTurnResponse,
} from "../protocol/voice-bots";
import { DTMFService } from "../services/dtmf-service";
import { MessageHandlerRegistry } from "../websocket/message-handlers/message-handler-registry";
import { BotService, BotResource, BotResponse } from "../services/bot-service";
import { ASRService, Transcript } from "../services/asr-service";
import { VADASRService } from "../services/vad-asr-service";

export class Session {
  private MAXIMUM_BINARY_MESSAGE_SIZE = 64000;
  private disconnecting = false;
  private closed = false;
  private ws;

  private messageHandlerRegistry = new MessageHandlerRegistry();
  private botService = new BotService();
  private asrService: ASRService | VADASRService | null = null;
  private dtmfService: DTMFService | null = null;
  private url;
  private clientSessionId;
  private conversationId: string | undefined;
  private lastServerSequenceNumber = 0;
  private lastClientSequenceNumber = 0;
  private inputVariables: JsonStringMap = {};
  private selectedMedia: MediaParameter | undefined;
  private selectedBot: BotResource | null = null;
  private isCapturingDTMF = false;
  private isAudioPlaying = false;
  private processingFinalTranscript = false;
  private transcriptionInProgress = false;
  private lastPartialTranscript = "";

  constructor(
    ws: WebSocket,
    sessionId: string,
    url: string,
    useVAD: boolean = true
  ) {
    this.ws = ws;
    this.clientSessionId = sessionId;
    this.url = url;

    // Inicializar el servicio ASR según la configuración
    if (useVAD) {
      this.asrService = new VADASRService(process.env.OPENAI_API_KEY);
    } else {
      // Usar el servicio ASR estándar (AWS o el que esté configurado)
      this.asrService = new ASRService();
    }

    // Configurar eventos del ASR
    this.setupASREvents();
  }

  /**
   * Configura los eventos del servicio ASR
   */
  private setupASREvents(): void {
    if (!this.asrService) return;

    // Manejar transcripciones parciales
    this.asrService.on("partial_transcript", (transcript: Transcript) => {
      if (this.isAudioPlaying) {
        console.log(
          "📝 Ignorando transcripción parcial durante reproducción de audio"
        );
        return;
      }

      // Actualizar última transcripción parcial
      this.lastPartialTranscript = transcript.text;
      console.log(
        `📝 Transcripción parcial: "${
          transcript.text
        }" (${transcript.confidence.toFixed(2)})`
      );
    });

    // Manejar transcripciones finales
    this.asrService.on("final_transcript", (transcript: Transcript) => {
      if (this.isAudioPlaying || this.processingFinalTranscript) {
        console.log(
          "📝 Ignorando transcripción final durante reproducción/procesamiento"
        );
        return;
      }

      console.log(
        `📝 Transcripción final: "${
          transcript.text
        }" (${transcript.confidence.toFixed(2)})`
      );

      // Procesar la transcripción con el bot
      this.processFinalTranscript(transcript);
    });

    // Manejar errores
    this.asrService.on("error", (error: Error) => {
      console.error("🔴 Error en ASR:", error);
    });
  }

  /**
   * Procesa una transcripción final y obtiene la respuesta del bot
   */
  private async processFinalTranscript(transcript: Transcript): Promise<void> {
    if (
      !transcript.text ||
      transcript.text.trim() === "" ||
      !this.selectedBot
    ) {
      console.log("❌ Transcripción vacía o bot no seleccionado");
      return;
    }

    this.processingFinalTranscript = true;
    try {
      // Enviar la transcripción al cliente
      console.log(`📤 Enviando transcripción a Genesys: "${transcript.text}"`);
      this.sendTurnResponse("match", transcript.text, transcript.confidence);

      // Obtener respuesta del bot
      console.log("🤖 Solicitando respuesta del bot...");
      const response = await this.selectedBot.getBotResponse(
        transcript.text,
        this.clientSessionId
      );

      // Enviar respuesta al cliente
      console.log(`🤖 Respuesta del bot: "${response.text}"`);
      this.sendTurnResponse(
        response.disposition,
        response.text,
        response.confidence || 1.0
      );

      // Reproducir audio si está disponible
      if (response.audioBytes && response.audioBytes.length > 0) {
        console.log(
          `🔊 Reproduciendo audio: ${response.audioBytes.length} bytes`
        );
        this.isAudioPlaying = true;

        // Asegurarnos de que se envíe el audio antes de cualquier otra acción
        try {
          this.sendAudio(response.audioBytes);
          console.log(`✅ Audio enviado correctamente a Genesys`);
        } catch (audioError) {
          console.error(`❌ Error enviando audio a Genesys:`, audioError);
        }
      } else {
        console.warn(`⚠️ No se recibió audio del bot para su respuesta`);
      }
    } catch (error) {
      console.error("🔴 Error procesando transcripción:", error);

      // Intentar enviar mensaje de error al cliente
      try {
        const errorMessage =
          "Lo siento, estoy teniendo problemas técnicos para procesar tu solicitud.";
        this.sendTurnResponse("no_match", errorMessage, 1.0);

        // Intentar generar audio de respaldo
        const backupResponse = await this.botService.getSystemResponse(
          errorMessage
        );
        if (backupResponse.audioBytes) {
          this.sendAudio(backupResponse.audioBytes);
        }
      } catch (recoveryError) {
        console.error(
          "🔴 Error al intentar recuperarse del error:",
          recoveryError
        );
      }
    } finally {
      this.processingFinalTranscript = false;
    }
  }

  close() {
    if (this.closed) {
      return;
    }

    try {
      this.ws.close();
    } catch {}

    this.closed = true;
  }

  setConversationId(conversationId: string) {
    this.conversationId = conversationId;
  }

  setInputVariables(inputVariables: JsonStringMap) {
    this.inputVariables = inputVariables;
  }

  setSelectedMedia(selectedMedia: MediaParameter) {
    this.selectedMedia = selectedMedia;
    console.log(`Media seleccionada: ${JSON.stringify(selectedMedia)}`);
  }

  setIsAudioPlaying(isAudioPlaying: boolean) {
    this.isAudioPlaying = isAudioPlaying;

    // Si la reproducción de audio ha terminado, reiniciar el ASR
    if (!isAudioPlaying && this.asrService) {
      this.asrService.resetForUserTurn();
      console.log("🔄 Reproducción de audio completada, ASR reiniciado");
    }
  }

  processTextMessage(data: string) {
    if (this.closed) {
      return;
    }

    const message = JSON.parse(data);

    if (message.seq !== this.lastClientSequenceNumber + 1) {
      console.log(`Invalid client sequence number: ${message.seq}.`);
      this.sendDisconnect("error", "Invalid client sequence number.", {});
      return;
    }

    this.lastClientSequenceNumber = message.seq;

    if (message.serverseq > this.lastServerSequenceNumber) {
      console.log(`Invalid server sequence number: ${message.serverseq}.`);
      this.sendDisconnect("error", "Invalid server sequence number.", {});
      return;
    }

    if (message.id !== this.clientSessionId) {
      console.log(`Invalid Client Session ID: ${message.id}.`);
      this.sendDisconnect("error", "Invalid ID specified.", {});
      return;
    }

    const handler = this.messageHandlerRegistry.getHandler(message.type);

    if (!handler) {
      console.log(`Cannot find a message handler for '${message.type}'.`);
      return;
    }

    handler.handleMessage(message as ClientMessage, this);
  }

  createMessage<Type extends ServerMessageType, Message extends ServerMessage>(
    type: Type,
    parameters: SelectParametersForType<Type, Message>
  ): ServerMessage {
    const message: ServerMessageBase<Type, typeof parameters> = {
      id: this.clientSessionId as string,
      version: "2",
      seq: ++this.lastServerSequenceNumber,
      clientseq: this.lastClientSequenceNumber,
      type,
      parameters,
    };

    return message as ServerMessage;
  }

  send(message: ServerMessage) {
    if (message.type === "event") {
      console.log(
        `Sending an ${message.type} message: ${message.parameters.entities[0].type}.`
      );
    } else {
      console.log(`Sending a ${message.type} message.`);
    }

    this.ws.send(JSON.stringify(message));
  }

  sendAudio(bytes: Uint8Array) {
    if (bytes.length <= this.MAXIMUM_BINARY_MESSAGE_SIZE) {
      console.log(`Sending ${bytes.length} binary bytes in 1 message.`);
      this.ws.send(bytes, { binary: true });
    } else {
      let currentPosition = 0;

      while (currentPosition < bytes.length) {
        const sendBytes = bytes.slice(
          currentPosition,
          currentPosition + this.MAXIMUM_BINARY_MESSAGE_SIZE
        );

        console.log(
          `Sending ${sendBytes.length} binary bytes in chunked message.`
        );
        this.ws.send(sendBytes, { binary: true });
        currentPosition += this.MAXIMUM_BINARY_MESSAGE_SIZE;
      }
    }
  }

  sendBargeIn() {
    const bargeInEvent: EventEntityBargeIn = {
      type: "barge_in",
      data: {},
    };
    const message = this.createMessage("event", {
      entities: [bargeInEvent],
    } as SelectParametersForType<"event", EventParameters>);

    this.send(message);
  }

  sendTurnResponse(
    disposition: BotTurnDisposition,
    text: string | undefined,
    confidence: number | undefined
  ) {
    const botTurnResponseEvent: EventEntityBotTurnResponse = {
      type: "bot_turn_response",
      data: {
        disposition,
        text,
        confidence,
      },
    };
    const message = this.createMessage("event", {
      entities: [botTurnResponseEvent],
    } as SelectParametersForType<"event", EventParameters>);

    this.send(message);

    // Cuando se envía una respuesta del bot, después será turno del usuario
    // Reiniciar el ASR para un nuevo turno del usuario
    setTimeout(() => {
      if (this.asrService) {
        this.asrService.resetForUserTurn();
        console.log(
          "🤖 Se envió respuesta del bot - Preparando ASR para turno del usuario"
        );
      }
    }, 100); // Pequeño retraso para asegurar que se complete el procesamiento actual
  }

  sendDisconnect(
    reason: DisconnectReason,
    info: string,
    outputVariables: JsonStringMap
  ) {
    this.disconnecting = true;

    const disconnectParameters: DisconnectParameters = {
      reason,
      info,
      outputVariables,
    };
    const message = this.createMessage("disconnect", disconnectParameters);

    this.send(message);
  }

  sendClosed() {
    const message = this.createMessage("closed", {});
    this.send(message);
  }

  /**
   * Verifica si el bot existe y lo configura para la sesión
   */
  checkIfBotExists(): Promise<boolean> {
    return this.botService
      .getBotIfExists(this.url, this.inputVariables)
      .then((botResource) => {
        if (botResource) {
          this.selectedBot = botResource;
          return true;
        }
        return false;
      });
  }

  /**
   * Inicia la sesión del bot con la respuesta inicial
   */
  async processBotStart() {
    if (!this.selectedBot) {
      console.log("No selected bot to start a bot session with.");
      return;
    }

    try {
      const result = await this.selectedBot.getInitialResponse();
      this.sendTurnResponse(result.disposition, result.text, result.confidence);

      if (result.audioBytes) {
        this.isAudioPlaying = true;
        this.sendAudio(result.audioBytes);
      }
    } catch (error) {
      console.error("Error in bot start:", error);
    }
  }

  /**
   * Procesa mensajes binarios (audio)
   */
  processBinaryMessage(data: Uint8Array) {
    if (this.disconnecting || this.closed) {
      return;
    }

    // Si estamos en modo de captura DTMF, no procesar como audio
    if (this.isCapturingDTMF) {
      // DTMFService no tiene un método processAudio, saltamos este paso
      console.log("En modo DTMF, ignorando audio para procesamiento ASR");
      return;
    }

    // Si no hay servicio ASR configurado, no procesar
    if (!this.asrService) {
      console.log("No ASR service configured, ignoring audio.");
      return;
    }

    // Ignorar audio si estamos reproduciendo audio (evita procesamiento concurrente)
    if (this.isAudioPlaying) {
      console.log("Ignoring audio input during audio playback");
      return;
    }

    // Procesar audio con el servicio ASR
    this.asrService.processAudio(data);
  }

  /**
   * Procesa dígitos DTMF
   */
  processDTMF(digit: string) {
    if (this.disconnecting || this.closed) {
      return;
    }

    console.log(`DTMF digit received: ${digit}`);

    if (this.dtmfService) {
      this.dtmfService.processDigit(digit);
    }
  }

  /**
   * Actualiza el estado de reproducción de audio
   * Mantiene compatibilidad con los manejadores de mensajes existentes
   */
  setAudioPlaybackState(playbackState: "started" | "completed") {
    const isPlaying = playbackState === "started";
    this.setIsAudioPlaying(isPlaying);

    console.log(`Reproducción de audio ${playbackState}`);
  }
}
