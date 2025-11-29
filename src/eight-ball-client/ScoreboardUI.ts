import { Memo, Middleware } from "polymatic";

import { Color, type BilliardContext } from "../eight-ball/BilliardContext";
import { isMyTurn, type ClientBilliardContext } from "./ClientContext";

/**
 * Updates the scoreboard UI: ball indicators, score, time, turn indicator
 */
export class ScoreboardUI extends Middleware<ClientBilliardContext> {
  p1Section: HTMLElement;
  p2Section: HTMLElement;
  p1BallsContainer: HTMLElement;
  p2BallsContainer: HTMLElement;
  turnAnnouncement: HTMLElement;
  turnText: HTMLElement;
  shotClock: HTMLElement;

  turnStartTime: number = 0;
  currentTurn: string = "";
  shotClockDuration: number = 60000; // 60 seconds
  announcementTimeout: ReturnType<typeof setTimeout> | null = null;
  
  // Track pocketed balls by player
  p1PocketedBalls: Set<number> = new Set();
  p2PocketedBalls: Set<number> = new Set();
  
  // Track balls currently animating (in flight) to their slots
  p1AnimatingBalls: Set<number> = new Set();
  p2AnimatingBalls: Set<number> = new Set();
  
  // Track if colors have been announced
  colorsAnnounced: boolean = false;
  
  // Track if foul announcement is pending (to prevent turn announcement from overwriting)
  foulAnnouncementPending: boolean = false;
  
  memo = Memo.init();

  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("deactivate", this.handleDeactivate);
    this.on("frame-loop", this.handleFrameLoop);
    this.on("ball-pocketed", this.handleBallPocketed);
    this.on("game-start", this.handleGameStart);
    this.on("foul", this.handleFoul);
    this.on("game-over", this.handleGameOver);
    this.on("shot-end", this.handleShotEnd);
  }

  handleShotEnd = () => {
    // Reset timer after every shot (whether turn changes or not)
    // Only update locally if not in online mode (server will sync turnStartTime)
    if (!this.context.room) {
      this.turnStartTime = Date.now();
    }
    this.timeoutTriggered = false;
  };

  handleActivate() {
    this.p1Section = document.getElementById("player1-section");
    this.p2Section = document.getElementById("player2-section");
    this.p1BallsContainer = document.getElementById("player1-balls");
    this.p2BallsContainer = document.getElementById("player2-balls");
    this.turnAnnouncement = document.getElementById("turn-announcement");
    this.turnText = document.getElementById("turn-text");
    this.shotClock = document.getElementById("shot-clock");
    
    // Don't start timer until game actually starts
    this.turnStartTime = 0;
    
    // Reset pocketed balls on activate
    this.p1PocketedBalls.clear();
    this.p2PocketedBalls.clear();
    this.p1AnimatingBalls.clear();
    this.p2AnimatingBalls.clear();
    this.colorsAnnounced = false;
  }

  handleGameStart = () => {
    // Reset pocketed balls when game starts
    this.p1PocketedBalls.clear();
    this.p2PocketedBalls.clear();
    this.p1AnimatingBalls.clear();
    this.p2AnimatingBalls.clear();
    this.colorsAnnounced = false;
    
    // Reset timer when game actually starts
    this.turnStartTime = Date.now();
    this.timeoutTriggered = false;
    
    // Force re-render of empty slots
    if (this.p1BallsContainer) this.p1BallsContainer.dataset.state = '';
    if (this.p2BallsContainer) this.p2BallsContainer.dataset.state = '';
  };

  handleDeactivate() {
    this.memo.clear();
    if (this.announcementTimeout) {
      clearTimeout(this.announcementTimeout);
    }
  }

  handleFrameLoop = () => {
    this.updateActivePlayer();
    this.updateBallIndicators();
    this.updateTimer();
    this.checkColorAssignment();
  };

  updateActivePlayer() {
    if (!this.context.turn || !this.context.players) return;

    const turn = this.context.turn.current;
    
    // Detect turn change to show announcement and reset timer
    if (turn !== this.currentTurn) {
      this.currentTurn = turn;
      // Only use local time in offline mode; online uses server-synced turnStartTime
      if (!this.context.room) {
        this.turnStartTime = Date.now();
      }
      this.timeoutTriggered = false; // Reset timeout flag for new turn
      // Don't show turn announcement if foul announcement is pending
      if (!this.foulAnnouncementPending) {
        this.showTurnAnnouncement();
      }
    }

    const p1 = this.context.players[0];
    const p2 = this.context.players[1];

    if (p1 && p1.turn === turn) {
      this.p1Section?.classList.add("active");
      this.p2Section?.classList.remove("active");
    } else if (p2 && p2.turn === turn) {
      this.p1Section?.classList.remove("active");
      this.p2Section?.classList.add("active");
    }
  }
  
  checkColorAssignment() {
    if (this.colorsAnnounced) return;
    
    const p1 = this.context.players?.[0];
    const p2 = this.context.players?.[1];
    
    // Check if colors have been assigned
    if (p1?.color && p2?.color) {
      this.colorsAnnounced = true;
      this.showColorAssignmentAnnouncement();
    }
  }
  
  showColorAssignmentAnnouncement() {
    if (!this.turnAnnouncement || !this.turnText) return;
    
    const p1 = this.context.players?.[0];
    const p2 = this.context.players?.[1];
    const turn = this.context.turn?.current;
    
    // Find who pocketed the ball (current player when colors were assigned)
    let playerName = "Player 1";
    let playerType = p1?.color === 'solid' ? 'Solids' : 'Stripes';
    
    if (p2 && p2.turn === turn) {
      playerName = "Player 2";
      playerType = p2?.color === 'solid' ? 'Solids' : 'Stripes';
    }
    
    this.turnText.textContent = `${playerName} is ${playerType}`;
    
    // Clear previous timeout
    if (this.announcementTimeout) {
      clearTimeout(this.announcementTimeout);
    }
    
    // Block cue stick from appearing during announcement
    this.context.turnAnnouncementInProgress = true;
    
    // Show announcement
    this.turnAnnouncement.classList.remove("fade-out");
    this.turnAnnouncement.classList.add("visible");
    
    // Fade out after 2 seconds (slightly longer for color announcement)
    this.announcementTimeout = setTimeout(() => {
      this.turnAnnouncement?.classList.add("fade-out");
      setTimeout(() => {
        this.turnAnnouncement?.classList.remove("visible", "fade-out");
        // Allow cue stick to appear after announcement is done
        this.context.turnAnnouncementInProgress = false;
      }, 300);
    }, 2000);
  }

  showTurnAnnouncement() {
    if (!this.turnAnnouncement || !this.turnText) return;
    
    const p1 = this.context.players?.[0];
    const p2 = this.context.players?.[1];
    const turn = this.context.turn?.current;
    
    let playerName = "Player 1";
    if (p2 && p2.turn === turn) {
      playerName = "Player 2";
    }
    
    this.turnText.textContent = `${playerName}'s Turn`;
    
    // Clear previous timeout
    if (this.announcementTimeout) {
      clearTimeout(this.announcementTimeout);
    }
    
    // Block cue stick from appearing during announcement
    this.context.turnAnnouncementInProgress = true;
    
    // Show announcement
    this.turnAnnouncement.classList.remove("fade-out");
    this.turnAnnouncement.classList.add("visible");
    
    // Fade out after 1.5 seconds
    this.announcementTimeout = setTimeout(() => {
      this.turnAnnouncement?.classList.add("fade-out");
      setTimeout(() => {
        this.turnAnnouncement?.classList.remove("visible", "fade-out");
        // Allow cue stick to appear after announcement is done
        this.context.turnAnnouncementInProgress = false;
      }, 300);
    }, 1500);
  }
  
  handleFoul = () => {
    // Set flag to prevent turn announcement from overwriting
    this.foulAnnouncementPending = true;
    this.showFoulAnnouncement();
  };
  
  showFoulAnnouncement() {
    if (!this.turnAnnouncement || !this.turnText) return;
    
    // Get the player whose turn it will be (the OTHER player, since foul passes turn)
    const p1 = this.context.players?.[0];
    const p2 = this.context.players?.[1];
    const currentTurn = this.context.turn?.current;
    
    // The player who DIDN'T foul gets the next turn
    let nextPlayerName = "Player 2";
    if (p2 && p2.turn === currentTurn) {
      // P2 fouled, so P1 gets next turn
      nextPlayerName = "Player 1";
    }
    
    this.turnText.innerHTML = `FOUL<br><span style="font-size: 18px;">${nextPlayerName}'s Turn</span>`;
    
    // Clear previous timeout
    if (this.announcementTimeout) {
      clearTimeout(this.announcementTimeout);
    }
    
    // Block cue stick from appearing during announcement
    this.context.turnAnnouncementInProgress = true;
    
    // Add foul class for red styling
    this.turnAnnouncement.classList.add("foul");
    this.turnAnnouncement.classList.remove("fade-out");
    this.turnAnnouncement.classList.add("visible");
    
    // Fade out after 2 seconds (longer since it has more info)
    this.announcementTimeout = setTimeout(() => {
      this.turnAnnouncement?.classList.add("fade-out");
      setTimeout(() => {
        this.turnAnnouncement?.classList.remove("visible", "fade-out", "foul");
        // Allow cue stick to appear after announcement is done
        this.context.turnAnnouncementInProgress = false;
        // Clear foul flag
        this.foulAnnouncementPending = false;
      }, 300);
    }, 2000);
  }

  handleGameOver = (data: { winner: any, loser: any, reason: string }) => {
    const { winner, loser, reason } = data;
    
    // Determine which player number won
    const p1 = this.context.players?.[0];
    const isP1Winner = winner?.id === p1?.id;
    const winnerNum = isP1Winner ? 1 : 2;
    const loserNum = isP1Winner ? 2 : 1;
    
    // Create game over overlay
    const overlay = document.createElement('div');
    overlay.id = 'game-over-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      pointer-events: auto;
    `;
    
    // Different messages for win vs lose by early 8-ball
    let mainText: string;
    let subText: string;
    let textColor: string;
    let glowColor: string;
    
    if (reason === 'legal-8ball') {
      mainText = `PLAYER ${winnerNum} WINS!`;
      subText = 'Cleared all balls and sunk the 8-ball!';
      textColor = '#4caf50';
      glowColor = 'rgba(76, 175, 80, 0.8)';
    } else {
      mainText = `PLAYER ${loserNum} LOSES!`;
      subText = 'Pocketed the 8-ball too early!';
      textColor = '#ff3333';
      glowColor = 'rgba(255, 51, 51, 0.8)';
    }
    
    overlay.innerHTML = `
      <style>
        @keyframes game-over-pop {
          0% { transform: scale(0.5); opacity: 0; }
          50% { transform: scale(1.1); }
          100% { transform: scale(1); opacity: 1; }
        }
        #game-over-main {
          font-size: 72px;
          font-weight: bold;
          color: ${textColor};
          text-shadow: 0 0 40px ${glowColor}, 0 0 80px ${glowColor}, 0 5px 20px rgba(0,0,0,0.8);
          text-transform: uppercase;
          letter-spacing: 12px;
          animation: game-over-pop 0.5s ease-out;
          margin-bottom: 20px;
          text-align: center;
        }
        #game-over-sub {
          font-size: 28px;
          font-weight: bold;
          color: ${textColor};
          text-shadow: 0 0 20px ${glowColor}, 0 3px 15px rgba(0,0,0,0.8);
          letter-spacing: 4px;
          animation: game-over-pop 0.5s ease-out 0.1s both;
          margin-bottom: 40px;
          text-align: center;
        }
        #play-again-btn {
          background: transparent;
          color: ${textColor};
          border: 3px solid ${textColor};
          padding: 15px 40px;
          font-size: 24px;
          font-weight: bold;
          letter-spacing: 4px;
          border-radius: 10px;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
          text-transform: uppercase;
          animation: game-over-pop 0.5s ease-out 0.2s both;
          box-shadow: 0 0 20px ${glowColor};
        }
        #play-again-btn:hover {
          transform: scale(1.1);
          background: ${textColor};
          color: #000;
          box-shadow: 0 0 40px ${glowColor};
        }
      </style>
      <div id="game-over-main">${mainText}</div>
      <div id="game-over-sub">${subText}</div>
      <button id="play-again-btn">Play Again</button>
    `;
    
    document.body.appendChild(overlay);
    
    // Add click handler to button
    const btn = document.getElementById('play-again-btn');
    if (btn) {
      btn.onclick = () => {
        overlay.remove();
        // Reload the page to start fresh
        window.location.reload();
      };
    }
  };

  // Track if timeout has been triggered for current turn
  timeoutTriggered: boolean = false;

  updateTimer() {
    if (!this.shotClock) return;
    
    // Hide clock if game hasn't started yet
    if (!this.context.gameStarted) {
      this.shotClock.classList.add("hidden");
      return;
    }
    
    // Hide clock during shot in progress
    if (this.context.shotInProgress) {
      this.shotClock.classList.add("hidden");
      return;
    }
    
    // Hide clock during ball in hand placement
    if (this.context.ballInHand) {
      this.shotClock.classList.add("hidden");
      return;
    }
    
    this.shotClock.classList.remove("hidden");
    
    // Use server-synced time in online mode, local time in offline mode
    const startTime = this.context.room && this.context.turnStartTime 
      ? this.context.turnStartTime 
      : this.turnStartTime;
    
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, this.shotClockDuration - elapsed);
    const seconds = Math.ceil(remaining / 1000);
    
    this.shotClock.textContent = String(seconds);
    
    // Update styling based on time remaining
    this.shotClock.classList.remove("warning", "danger");
    if (seconds <= 3) {
      this.shotClock.classList.add("danger");
    } else if (seconds <= 5) {
      this.shotClock.classList.add("warning");
    }
    
    // Check for timeout - only handle locally in offline mode
    // In online mode, server handles turn timing
    if (!this.context.room && remaining === 0 && !this.timeoutTriggered && !this.context.ballInHand) {
      this.timeoutTriggered = true;
      this.handleTimeout();
    }
  }
  
  handleTimeout() {
    // Show timeout announcement
    this.showTimeoutAnnouncement();
    
    // Pass turn to other player
    this.emit("pass-turn");
  }
  
  showTimeoutAnnouncement() {
    if (!this.turnAnnouncement || !this.turnText) return;
    
    // Get the player whose turn it will be (the OTHER player)
    const p1 = this.context.players?.[0];
    const p2 = this.context.players?.[1];
    const currentTurn = this.context.turn?.current;
    
    // The OTHER player gets the next turn
    let nextPlayerName = "Player 2";
    if (p2 && p2.turn === currentTurn) {
      nextPlayerName = "Player 1";
    }
    
    this.turnText.innerHTML = `TIME OUT<br><span style="font-size: 18px;">${nextPlayerName}'s Turn</span>`;
    
    // Clear previous timeout
    if (this.announcementTimeout) {
      clearTimeout(this.announcementTimeout);
    }
    
    // Block cue stick from appearing during announcement
    this.context.turnAnnouncementInProgress = true;
    
    // Add timeout class for styling (use same as foul - red)
    this.turnAnnouncement.classList.add("timeout");
    this.turnAnnouncement.classList.remove("fade-out");
    this.turnAnnouncement.classList.add("visible");
    
    // Fade out after 2 seconds
    this.announcementTimeout = setTimeout(() => {
      this.turnAnnouncement?.classList.add("fade-out");
      setTimeout(() => {
        this.turnAnnouncement?.classList.remove("visible", "fade-out", "timeout");
        // Allow cue stick to appear after announcement is done
        this.context.turnAnnouncementInProgress = false;
      }, 300);
    }, 2000);
  }

  updateBallIndicators() {
    if (!this.context.players) return;

    const p1 = this.context.players[0];
    const p2 = this.context.players[1];

    // Check if colors have been assigned yet
    const colorsAssigned = p1?.color || p2?.color;

    if (!colorsAssigned) {
      // Show empty ball slots when colors not yet assigned
      this.renderEmptySlots(this.p1BallsContainer, 7);
      this.renderEmptySlots(this.p2BallsContainer, 7);
      return;
    }

    // Default assignments if not set
    const p1Type = p1?.color || (p2?.color === 'solid' ? 'stripe' : 'solid');
    const p2Type = p2?.color || (p1?.color === 'solid' ? 'stripe' : 'solid');

    this.renderCollectedBalls(this.p1BallsContainer, p1Type, this.p1PocketedBalls);
    this.renderCollectedBalls(this.p2BallsContainer, p2Type, this.p2PocketedBalls);
  }

  renderEmptySlots(container: HTMLElement, count: number) {
    if (!container) return;
    
    // Only update if not already showing empty state
    if (container.dataset.state === 'empty') return;
    container.dataset.state = 'empty';
    
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const slot = document.createElement("div");
      slot.className = "mini-ball empty-slot";
      container.appendChild(slot);
    }
  }

  renderCollectedBalls(container: HTMLElement, type: "solid" | "stripe", pocketedBalls: Set<number>) {
    if (!container) return;

    // Generate a key for current state to avoid unnecessary re-renders
    // Use array order (insertion order) for the key, not sorted
    const stateKey = `collected-${type}-${Array.from(pocketedBalls).join(',')}`;
    if (container.dataset.state === stateKey) return;
    container.dataset.state = stateKey;

    // Keep balls in the order they were pocketed (Set maintains insertion order)
    const pocketedArray = Array.from(pocketedBalls);
    const totalSlots = 7;

    container.innerHTML = '';

    // First render collected balls (these appear closest to profile, in order pocketed)
    for (const ballNum of pocketedArray) {
      const ball = document.createElement("div");
      ball.className = `mini-ball ball-${ballNum}`;
      ball.setAttribute('data-ball', String(ballNum));
      ball.textContent = String(ballNum);
      container.appendChild(ball);
    }
    
    // Then render empty slots for remaining
    const emptyCount = totalSlots - pocketedArray.length;
    for (let i = 0; i < emptyCount; i++) {
      const slot = document.createElement("div");
      slot.className = "mini-ball empty-slot";
      container.appendChild(slot);
    }
  }

  renderBalls(container: HTMLElement, type: "solid" | "stripe") {
    if (!container) return;

    // Clear unknown state
    container.dataset.state = 'known';

    // Determine range
    const start = type === 'solid' ? 1 : 9;
    const end = type === 'solid' ? 7 : 15;

    // Get balls currently on table
    const ballsOnTable = new Set<number>();
    for (const ball of this.context.balls) {
        // Extract number from color (e.g. "yellow-solid" -> 1)
        // This mapping needs to match Terminal.ts logic
        const num = this.getBallNumber(ball.color);
        if (num) ballsOnTable.add(num);
    }

    // Re-render only if changed (simple diffing by clearing for now, optimized later if needed)
    container.innerHTML = '';

    for (let i = start; i <= end; i++) {
        if (ballsOnTable.has(i)) {
            const ball = document.createElement("div");
            ball.className = `mini-ball ball-${i}`;
            ball.textContent = String(i);
            container.appendChild(ball);
        }
    }
  }

  getBallNumber(colorString: string): number | null {
      if (colorString === 'black') return 8;
      if (colorString === 'white') return 0;
      
      const parts = colorString.split('-');
      const color = parts[0];
      const style = parts[1];
      
      const map: Record<string, number> = {
          'yellow': 1, 'blue': 2, 'red': 3, 'purple': 4, 
          'orange': 5, 'green': 6, 'burgundy': 7
      };
      
      let num = map[color];
      if (!num) return null;
      
      if (style === 'stripe') num += 8;
      return num;
  }

  handleBallPocketed = (data: { ball: any, pocket: any }) => {
    const { ball, pocket } = data;
    
    // Skip cue ball and 8 ball for this animation
    if (ball.color === 'white' || ball.color === 'black') return;
    
    const ballNum = this.getBallNumber(ball.color);
    if (!ballNum) return;
    
    // Determine which player this ball belongs to
    const isSolid = Color.is(ball.color, 'solid');
    const p1 = this.context.players?.[0];
    const p2 = this.context.players?.[1];
    
    let targetContainer: HTMLElement | null = null;
    let targetPocketedSet: Set<number> | null = null;
    let targetAnimatingSet: Set<number> | null = null;
    
    // Figure out target based on player colors (if assigned)
    if (p1?.color === 'solid' && isSolid) {
      targetContainer = this.p1BallsContainer;
      targetPocketedSet = this.p1PocketedBalls;
      targetAnimatingSet = this.p1AnimatingBalls;
    } else if (p1?.color === 'stripe' && !isSolid) {
      targetContainer = this.p1BallsContainer;
      targetPocketedSet = this.p1PocketedBalls;
      targetAnimatingSet = this.p1AnimatingBalls;
    } else if (p2?.color === 'solid' && isSolid) {
      targetContainer = this.p2BallsContainer;
      targetPocketedSet = this.p2PocketedBalls;
      targetAnimatingSet = this.p2AnimatingBalls;
    } else if (p2?.color === 'stripe' && !isSolid) {
      targetContainer = this.p2BallsContainer;
      targetPocketedSet = this.p2PocketedBalls;
      targetAnimatingSet = this.p2AnimatingBalls;
    } else {
      // Colors not assigned yet, determine from current turn
      const currentPlayer = this.context.players?.find(p => p.turn === this.context.turn?.current);
      if (currentPlayer === p1) {
        targetContainer = this.p1BallsContainer;
        targetPocketedSet = this.p1PocketedBalls;
        targetAnimatingSet = this.p1AnimatingBalls;
      } else {
        targetContainer = this.p2BallsContainer;
        targetPocketedSet = this.p2PocketedBalls;
        targetAnimatingSet = this.p2AnimatingBalls;
      }
    }
    
    if (!targetContainer || !targetPocketedSet || !targetAnimatingSet) return;
    
    // Count how many balls already collected OR animating - the new ball will go to the NEXT empty slot
    // This prevents two balls pocketed in quick succession from targeting the same slot
    const collectedCount = targetPocketedSet.size + targetAnimatingSet.size;
    
    // Add ball to animating set immediately to reserve its slot
    targetAnimatingSet.add(ballNum);
    
    // DON'T add ball to pocketed set yet - wait until animation completes
    // This prevents the ball from appearing in the UI before the animation reaches it
    
    // Get SVG and pocket position in screen coordinates
    const svgEl = document.getElementById("polymatic-eight-ball");
    if (!svgEl || !(svgEl instanceof SVGSVGElement)) return;
    const svg = svgEl;
    
    // Convert pocket world position to screen position
    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    
    // Pocket position in world coords
    const pocketX = pocket.position.x;
    const pocketY = pocket.position.y;
    
    // Convert to screen coords
    const scaleX = svgRect.width / viewBox.width;
    const scaleY = svgRect.height / viewBox.height;
    const screenX = svgRect.left + (pocketX - viewBox.x) * scaleX;
    const screenY = svgRect.top + (pocketY - viewBox.y) * scaleY;
    
    // Find the target slot position - should be the FIRST EMPTY slot (farthest from profile)
    // Before re-render: collected balls are at indices 0 to collectedCount-1
    // Empty slots are at indices collectedCount to 6
    // The new ball should animate to the first empty slot (index collectedCount)
    const slots = targetContainer.querySelectorAll('.mini-ball');
    
    let targetX: number;
    let targetY: number;
    
    // Target the first empty slot (at index collectedCount, which is farthest from profile)
    const targetSlotIndex = collectedCount;
    if (slots.length > targetSlotIndex) {
      const targetSlot = slots[targetSlotIndex] as HTMLElement;
      const slotRect = targetSlot.getBoundingClientRect();
      targetX = slotRect.left + slotRect.width / 2;
      targetY = slotRect.top + slotRect.height / 2;
    } else {
      // Fallback to container center
      const targetRect = targetContainer.getBoundingClientRect();
      targetX = targetRect.left + targetRect.width / 2;
      targetY = targetRect.top + targetRect.height / 2;
    }
    
    // Create animated ball element
    const animBall = document.createElement("div");
    animBall.className = `animated-ball mini-ball ball-${ballNum}`;
    animBall.textContent = String(ballNum);
    animBall.style.cssText = `
      position: fixed;
      left: ${screenX}px;
      top: ${screenY}px;
      transform: translate(-50%, -50%) scale(2);
      z-index: 1000;
      transition: all 1s ease-in-out;
      pointer-events: none;
    `;
    
    document.body.appendChild(animBall);
    
    // Trigger animation to target
    requestAnimationFrame(() => {
      animBall.style.left = `${targetX}px`;
      animBall.style.top = `${targetY}px`;
      animBall.style.transform = 'translate(-50%, -50%) scale(1)';
    });
    
    // Remove after animation completes (match transition duration + small buffer)
    setTimeout(() => {
      animBall.remove();
      
      // Remove from animating set and add to pocketed set (after animation completes)
      targetAnimatingSet.delete(ballNum);
      targetPocketedSet.add(ballNum);
      
      // Force re-render to show ball in its final position
      targetContainer.dataset.state = ''; // Clear state to force re-render
      this.renderCollectedBalls(targetContainer, 
        targetContainer === this.p1BallsContainer ? 
          (this.context.players?.[0]?.color || 'solid') : 
          (this.context.players?.[1]?.color || 'stripe'),
        targetPocketedSet
      );
    }, 1050);
  };
}
