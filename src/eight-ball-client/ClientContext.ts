import { BilliardContext, type Player } from "../eight-ball/BilliardContext";

export interface Auth {
  id: string;
  secret: string;
}

export class ClientBilliardContext extends BilliardContext {
  player?: Player;
  room?: string;
  auth?: Auth;
  turnAnnouncementInProgress?: boolean;
  
  // Opponent aiming state (for showing their cue movement)
  opponentAiming?: boolean;
  opponentAim?: { x: number; y: number };
  opponentPower?: number;
}

export const isMyTurn = (context: ClientBilliardContext) => {
  if (context.shotInProgress || context.gameOver || !context.gameStarted) return false;
  
  // Wait for turn announcement to finish before showing cue
  if (context.turnAnnouncementInProgress) return false;
  
  // Don't show cue during ball in hand (placement mode)
  if (context.ballInHand) return false;
  
  // Offline / Hotseat mode: always allow control if no room/auth is set
  if (!context.room && !context.auth) return true;

  if (context.turn?.current !== context.player?.turn) return false;
  return true;
};
