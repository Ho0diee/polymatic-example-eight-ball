import { Middleware } from "polymatic";
import { type ClientBilliardContext } from "./ClientContext";

/**
 * Manages all game audio using the Web Audio API for low-latency playback.
 * Preloads sounds and plays them in response to game events.
 */
export class SoundManager extends Middleware<ClientBilliardContext> {
  private audioContext: AudioContext | null = null;
  private sounds: Map<string, AudioBuffer[]> = new Map();
  private isLoaded = false;
  private isMuted = false;
  private masterVolume = 0.7;

  // Prevent sound spam - track last play time per sound type
  private lastPlayTime: Map<string, number> = new Map();
  private minInterval = 50; // ms between same sound type

  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("shot-start", this.handleShotStart);
    this.on("ball-collision", this.handleBallCollision);
    this.on("rail-collision", this.handleRailCollision);
    this.on("ball-pocketed", this.handleBallPocketed);
  }

  handleActivate = async () => {
    // Initialize on first user interaction (browser requirement)
    const initAudio = async () => {
      if (this.audioContext) return;
      
      this.audioContext = new AudioContext();
      await this.preloadSounds();
      this.isLoaded = true;
      
      // Remove listeners after init
      document.removeEventListener("click", initAudio);
      document.removeEventListener("touchstart", initAudio);
      document.removeEventListener("keydown", initAudio);
    };

    // Try to init immediately, but also add listeners for user interaction
    document.addEventListener("click", initAudio, { once: false });
    document.addEventListener("touchstart", initAudio, { once: false });
    document.addEventListener("keydown", initAudio, { once: false });
    
    // Try immediate init (may work if user already interacted)
    try {
      await initAudio();
    } catch (e) {
      // Will init on user interaction
    }
  };

  private async preloadSounds() {
    if (!this.audioContext) return;

    const soundFiles = {
      "cue-shot": ["/sounds/cue-shot-1.wav", "/sounds/cue-shot-2.wav"],
      "ball-ball": ["/sounds/ball-ball-1.wav", "/sounds/ball-ball-2.wav", "/sounds/ball-ball-3.wav"],
      "ball-rail": ["/sounds/ball-rail-1.wav", "/sounds/ball-rail-2.wav", "/sounds/ball-rail-3.wav"],
      "pocket": ["/sounds/pocket-1.wav", "/sounds/pocket-2.wav", "/sounds/pocket-3.wav"],
    };

    for (const [name, files] of Object.entries(soundFiles)) {
      const buffers: AudioBuffer[] = [];
      for (const file of files) {
        try {
          const response = await fetch(file);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
          buffers.push(audioBuffer);
        } catch (e) {
          console.warn(`Failed to load sound: ${file}`, e);
        }
      }
      if (buffers.length > 0) {
        this.sounds.set(name, buffers);
      }
    }
    
    console.log(`[SoundManager] Loaded ${this.sounds.size} sound groups`);
  }

  private playSound(name: string, volume: number = 1.0) {
    if (!this.audioContext || !this.isLoaded || this.isMuted) return;
    
    // Throttle same sound type
    const now = performance.now();
    const lastTime = this.lastPlayTime.get(name) || 0;
    if (now - lastTime < this.minInterval) return;
    this.lastPlayTime.set(name, now);

    const buffers = this.sounds.get(name);
    if (!buffers || buffers.length === 0) return;

    // Pick random variant
    const buffer = buffers[Math.floor(Math.random() * buffers.length)];

    // Create nodes
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();

    source.buffer = buffer;
    gainNode.gain.value = volume * this.masterVolume;

    // Connect: source -> gain -> output
    source.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    source.start(0);
  }

  handleShotStart = () => {
    this.playSound("cue-shot", 0.8);
  };

  handleBallCollision = (data: { ball1: any; ball2: any; impactSpeed: number }) => {
    // Scale volume by impact speed (0.05 to 2.0 typical range)
    const volume = Math.min(1.0, data.impactSpeed / 1.5);
    if (volume > 0.1) {
      this.playSound("ball-ball", volume);
    }
  };

  handleRailCollision = (data: { ball: any; speed: number }) => {
    // Scale volume by speed
    const volume = Math.min(1.0, data.speed / 1.2);
    if (volume > 0.15) {
      this.playSound("ball-rail", volume);
    }
  };

  handleBallPocketed = (data: { ball: any; pocket: any }) => {
    this.playSound("pocket", 0.9);
  };

  // Public API for mute toggle
  setMuted(muted: boolean) {
    this.isMuted = muted;
  }

  setVolume(volume: number) {
    this.masterVolume = Math.max(0, Math.min(1, volume));
  }
}
