declare module "node-vad" {
  /**
   * VAD (Voice Activity Detection) class
   */
  class VAD {
    /**
     * Creates a new VAD instance
     * @param mode The VAD mode to use
     */
    constructor(mode: number);

    /**
     * Process audio data to detect voice activity
     * @param buffer Audio buffer to process (PCM 16bit, 16kHz, mono)
     * @param sampleRate Sample rate of the audio
     * @returns Promise that resolves to a VAD Event
     */
    processAudio(buffer: Buffer, sampleRate: number): Promise<number>;

    /**
     * VAD modes
     */
    static Mode: {
      /**
       * Normal mode (least aggressive)
       */
      NORMAL: number;

      /**
       * Low bitrate mode
       */
      LOW_BITRATE: number;

      /**
       * Aggressive mode
       */
      AGGRESSIVE: number;

      /**
       * Very aggressive mode
       */
      VERY_AGGRESSIVE: number;
    };

    /**
     * VAD events
     */
    static Event: {
      /**
       * Silence detected
       */
      SILENCE: number;

      /**
       * Voice detected
       */
      VOICE: number;

      /**
       * Noise detected (non-voice)
       */
      NOISE: number;
    };
  }

  export = VAD;
}
