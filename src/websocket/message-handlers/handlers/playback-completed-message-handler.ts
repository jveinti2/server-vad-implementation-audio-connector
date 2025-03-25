import { ClientMessage } from "../../../protocol/message";
import { Session } from "../../../common/session";
import { MessageHandler } from "../message-handler";

export class PlaybackCompletedMessageHandler implements MessageHandler {
  handleMessage(message: ClientMessage, session: Session) {
    console.log("Received a Playback Completed Message.");

    // Usar el método para marcar que el audio ha terminado de reproducirse
    session.setAudioPlaybackState("completed");

    // Log para confirmar que el sistema está listo para recibir nuevo audio
    console.log(
      "✅ Reproducción finalizada - Sistema listo para recibir audio"
    );
  }
}
