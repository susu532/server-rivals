/**
 * @copyright 2026 hentertrabelsi
 * @contact Email: hentertrabelsi@gmail.com
 * @discord #susuxo
 * 
 * All rights reserved. This software is proprietary and confidential.
 * You may not use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software without explicit permission.
 */
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import http from "http";
import path from "path";
import fs from "fs";
import * as CANNON from "cannon-es";
import cors from "cors";

const PORT = Number(process.env.PORT) || 3000;
const TICK_RATE = 60;
const TICK_DT = 1 / TICK_RATE;

// Game State Interfaces
interface PlayerState {
  id: string;
  name: string;
  position: [number, number, number];
  velocity: [number, number, number];
  rotation: [number, number, number, number];
  color: string;
  team: 'red' | 'blue';
  score: number;
  lastKickTime: number;
  lastJumpTime: number;
  character: string;
  goals: number;
  assists: number;
  kicks: number;
  worldCupCountry?: string;
}

interface GameState {
  players: Record<string, PlayerState>;
  ball: {
    position: [number, number, number];
    velocity: [number, number, number];
    rotation: [number, number, number, number];
  };
  score: { red: number; blue: number };
  matchState: 'waiting' | 'playing' | 'goal' | 'gameover' | 'freeplay' | 'countdown';
  timer: number;
  message: string;
  isOvertime: boolean;
  isWorldCup: boolean;
  worldCupTeams?: { red: string; blue: string };
  lastScorer?: {
    name: string;
    team: 'red' | 'blue';
    country?: string;
  };
}

interface Room {
  id: string;
  isPrivate: boolean;
  isTraining: boolean;
  isWorldCup: boolean;
  difficulty: 'easy' | 'medium' | 'hard';
  botIds: string[];
  world: CANNON.World;
  gameState: GameState;
  playerBodies: Record<string, CANNON.Body>;
  playerInputs: Record<string, { x: number; z: number; kick: boolean; jump: boolean; cameraAngle: number }>;
  ballBody: CANNON.Body;
  playerMaterial: CANNON.Material;
  ticks: number;
  stateTimer: number;
  resetPositions: () => void;
  lastTouchId: string | null;
  secondLastTouchId: string | null;
}

const rooms = new Map<string, Room>();

function createRoom(roomId: string, isPrivate: boolean, isTraining: boolean = false, difficulty: 'easy' | 'medium' | 'hard' = 'medium', isWorldCup: boolean = false): Room {
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.82, 0),
  });

  // Materials
  const groundMaterial = new CANNON.Material('ground');
  const ballMaterial = new CANNON.Material('ball');
  const playerMaterial = new CANNON.Material('player');
  const wallMaterial = new CANNON.Material('wall');

  world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, ballMaterial, { friction: 1.0, restitution: 0.4 }));
  world.addContactMaterial(new CANNON.ContactMaterial(wallMaterial, ballMaterial, { friction: 0.0, restitution: 0.1 }));
  world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, playerMaterial, { friction: 0.0, restitution: 0.0 }));
  world.addContactMaterial(new CANNON.ContactMaterial(playerMaterial, ballMaterial, { friction: 0.2, restitution: 0.4 }));
  world.addContactMaterial(new CANNON.ContactMaterial(playerMaterial, wallMaterial, { friction: 0.0, restitution: 0.0 }));
  world.addContactMaterial(new CANNON.ContactMaterial(playerMaterial, playerMaterial, { friction: 0.1, restitution: 0.5 }));

  // Ground
  const groundBody = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Plane(),
    material: groundMaterial,
  });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  // Walls
  const fieldWidth = 30;
  const fieldLength = 40;
  const wallHeight = 20;
  const goalWidth = 8;
  const goalDepth = 2;
  const goalHeight = 3.6;

  const createWall = (x: number, y: number, z: number, width: number, height: number, depth: number) => {
    const wall = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)),
      position: new CANNON.Vec3(x, y, z),
      material: wallMaterial,
    });
    world.addBody(wall);
  };

  const wallWidth = (fieldWidth - goalWidth) / 2;
  const wallOffset = goalWidth / 2 + wallWidth / 2;

  createWall(-wallOffset, wallHeight / 2, -fieldLength / 2, wallWidth, wallHeight, 1);
  createWall(wallOffset, wallHeight / 2, -fieldLength / 2, wallWidth, wallHeight, 1);
  createWall(0, goalHeight + (wallHeight - goalHeight) / 2, -fieldLength / 2, goalWidth, wallHeight - goalHeight, 1);
  
  createWall(-wallOffset, wallHeight / 2, fieldLength / 2, wallWidth, wallHeight, 1);
  createWall(wallOffset, wallHeight / 2, fieldLength / 2, wallWidth, wallHeight, 1);
  createWall(0, goalHeight + (wallHeight - goalHeight) / 2, fieldLength / 2, goalWidth, wallHeight - goalHeight, 1);

  createWall(-fieldWidth / 2, wallHeight / 2, 0, 1, wallHeight, fieldLength);
  createWall(fieldWidth / 2, wallHeight / 2, 0, 1, wallHeight, fieldLength);

  createWall(0, goalHeight / 2, -fieldLength / 2 - goalDepth, goalWidth, goalHeight, 1);
  createWall(-goalWidth / 2, goalHeight / 2, -fieldLength / 2 - goalDepth / 2, 1, goalHeight, goalDepth);
  createWall(goalWidth / 2, goalHeight / 2, -fieldLength / 2 - goalDepth / 2, 1, goalHeight, goalDepth);
  createWall(0, goalHeight, -fieldLength / 2 - goalDepth / 2, goalWidth, 1, goalDepth);

  createWall(0, goalHeight / 2, fieldLength / 2 + goalDepth, goalWidth, goalHeight, 1);
  createWall(-goalWidth / 2, goalHeight / 2, fieldLength / 2 + goalDepth / 2, 1, goalHeight, goalDepth);
  createWall(goalWidth / 2, goalHeight / 2, fieldLength / 2 + goalDepth / 2, 1, goalHeight, goalDepth);
  createWall(0, goalHeight, fieldLength / 2 + goalDepth / 2, goalWidth, 1, goalDepth);

  createWall(0, wallHeight, 0, fieldWidth, 1, fieldLength + goalDepth * 2);

  // Ball
  const ballBody = new CANNON.Body({
    mass: 0.8,
    shape: new CANNON.Sphere(0.5),
    position: new CANNON.Vec3(0, 5, 0),
    material: ballMaterial,
    linearDamping: 0.5,
    angularDamping: 0.9,
  });
  world.addBody(ballBody);

  const gameState: GameState = {
    players: {},
    ball: { position: [0, 5, 0], velocity: [0, 0, 0], rotation: [0, 0, 0, 1] },
    score: { red: 0, blue: 0 },
    matchState: 'waiting',
    timer: 0,
    message: 'Waiting for players...',
    isOvertime: false,
    isWorldCup,
  };

  const playerBodies: Record<string, CANNON.Body> = {};
  
  const resetPositions = () => {
    ballBody.position.set(0, 5, 0);
    ballBody.velocity.set(0, 0, 0);
    ballBody.angularVelocity.set(0, 0, 0);

    const bluePlayers = Object.values(gameState.players).filter(p => p.team === 'blue');
    const redPlayers = Object.values(gameState.players).filter(p => p.team === 'red');

    let blueIdx = 0;
    let redIdx = 0;
    for (const id in playerBodies) {
      const p = playerBodies[id];
      const state = gameState.players[id];
      if (!state) continue;
      
      const isBlue = state.team === 'blue';
      const z = isBlue ? -10 : 10;
      
      if (isBlue) {
        const total = bluePlayers.length;
        const offset = (total - 1) * 2;
        const x = (blueIdx++ * 4) - offset;
        p.position.set(x, 1, z);
      } else {
        const total = redPlayers.length;
        const offset = (total - 1) * 2;
        const x = (redIdx++ * 4) - offset;
        p.position.set(x, 1, z);
      }
      
      p.velocity.set(0, 0, 0);
      p.angularVelocity.set(0, 0, 0);
    }
  };

  return {
    id: roomId,
    isPrivate,
    isTraining,
    isWorldCup,
    difficulty,
    botIds: [],
    world,
    gameState,
    playerBodies,
    playerInputs: {},
    ballBody,
    playerMaterial,
    ticks: 0,
    stateTimer: 0,
    resetPositions,
    lastTouchId: null,
    secondLastTouchId: null,
  };
}

// Helper to generate random room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const HUMAN_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Casey', 'Riley', 'Morgan', 'Jamie', 'Quinn', 'Avery', 'Leo', 'Mia', 'Noah', 'Emma', 'Oliver', 'Ava', 'Elijah', 'Sophia', 'Lucas', 'Isabella'];

function getPlayerDimensions(character: string) {
  if (character === 'fox') {
    return new CANNON.Vec3(0.25, 0.5, 0.25);
  }
  return new CANNON.Vec3(0.5, 1, 0.5);
}

function createPlayerBody(character: string, startZ: number, material: CANNON.Material) {
  const dims = getPlayerDimensions(character);
  const radius = dims.x;
  const halfHeight = dims.y;
  const totalHeight = halfHeight * 2;
  
  const body = new CANNON.Body({
    mass: 5,
    material: material,
    fixedRotation: true,
    linearDamping: 0.9,
    position: new CANNON.Vec3((Math.random() - 0.5) * 10, halfHeight, startZ),
  });

  // Cylinder for the middle
  const cylinderHeight = totalHeight - radius * 2;
  if (cylinderHeight > 0) {
    const cylinderShape = new CANNON.Cylinder(radius, radius, cylinderHeight, 16);
    const q = new CANNON.Quaternion();
    q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    body.addShape(cylinderShape, new CANNON.Vec3(0, 0, 0), q);
  } else if (cylinderHeight === 0) {
    // If it's exactly a sphere (e.g. radius = halfHeight)
    // Just the two spheres will overlap perfectly, which is fine.
  }

  // Spheres for top and bottom to create a capsule
  const sphereShape = new CANNON.Sphere(radius);
  body.addShape(sphereShape, new CANNON.Vec3(0, halfHeight - radius, 0));
  body.addShape(sphereShape, new CANNON.Vec3(0, -(halfHeight - radius), 0));

  // Flat front bumper (Box) to push the ball better
  // Positioned at local +Z (which corresponds to the front when rotated)
  const bumperShape = new CANNON.Box(new CANNON.Vec3(radius * 1.5, halfHeight * 0.6, 0.1));
  body.addShape(bumperShape, new CANNON.Vec3(0, 0, radius));

  return body;
}

function addBot(room: Room, team: 'red' | 'blue', humanLike: boolean = false) {
  const botId = `bot_${Math.random().toString(36).substring(2, 8)}`;
  const color = team === 'red' ? '#ff007f' : '#00ffff';
  const startZ = team === 'red' ? 10 : -10;

  const botBody = createPlayerBody('robot', startZ, room.playerMaterial);
  room.world.addBody(botBody);
  room.playerBodies[botId] = botBody;
  room.playerInputs[botId] = { x: 0, z: 0, kick: false, jump: false, cameraAngle: 0 };
  room.botIds.push(botId);

  const name = humanLike ? HUMAN_NAMES[Math.floor(Math.random() * HUMAN_NAMES.length)] : `AI (${room.difficulty.toUpperCase()})`;

  room.gameState.players[botId] = {
    id: botId,
    name,
    position: [botBody.position.x, botBody.position.y, botBody.position.z],
    velocity: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    color,
    team,
    score: 0,
    lastKickTime: 0,
    lastJumpTime: 0,
    character: 'robot',
    goals: 0,
    assists: 0,
    kicks: 0,
  };

  return botId;
}

function updateBots(room: Room) {
  if (room.botIds.length === 0) return;

  const ballPos = room.ballBody.position;
  // Increase reaction delay to make them slower to respond
  const reactionDelay = room.difficulty === 'easy' ? 45 : room.difficulty === 'medium' ? 20 : 5;

  // Find the single closest bot to the ball across ALL bots
  let absoluteClosestBotId: string | null = null;
  let minDistance = Infinity;
  
  // Track assigned defenders
  const defendersAssigned: { red: boolean; blue: boolean } = { red: false, blue: false };
  const botRoles: Record<string, 'attacker' | 'defender'> = {};

  for (const botId of room.botIds) {
    const botBody = room.playerBodies[botId];
    if (!botBody) continue;
    const dist = Math.sqrt(Math.pow(ballPos.x - botBody.position.x, 2) + Math.pow(ballPos.z - botBody.position.z, 2));
    if (dist < minDistance) {
      minDistance = dist;
      absoluteClosestBotId = botId;
    }
  }

  for (const botId of room.botIds) {
    const botState = room.gameState.players[botId];
    if (!botState) continue;
    
    if (botId === absoluteClosestBotId) {
      botRoles[botId] = 'attacker';
    } else if (!defendersAssigned[botState.team]) {
      botRoles[botId] = 'defender';
      defendersAssigned[botState.team] = true;
    } else {
      // If already have a defender, this bot becomes a secondary attacker/midfielder
      botRoles[botId] = 'attacker';
    }
  }

  for (const botId of room.botIds) {
    const botBody = room.playerBodies[botId];
    const botState = room.gameState.players[botId];
    if (!botBody || !botState) continue;

    // Only update input every few ticks based on difficulty
    if (room.ticks % reactionDelay !== 0) continue;

    const input = room.playerInputs[botId];
    let targetX: number;
    let targetZ: number;
    const opponentGoalZ = botState.team === 'red' ? -20 : 20;
    const ownGoalZ = botState.team === 'red' ? 20 : -20;

    // Vector to ball
    const toBallX = ballPos.x - botBody.position.x;
    const toBallZ = ballPos.z - botBody.position.z;
    const distToBall = Math.sqrt(toBallX * toBallX + toBallZ * toBallZ);

    const isAttacker = botRoles[botId] === 'attacker';
    const isFillBot = !room.isTraining;

    if (isAttacker) {
      // Vector from goal to ball
      const goalToBallX = ballPos.x - 0;
      const goalToBallZ = ballPos.z - opponentGoalZ;
      const len = Math.sqrt(goalToBallX * goalToBallX + goalToBallZ * goalToBallZ) || 1;
      
      // Ideal position to strike from (behind the ball relative to the goal)
      const idealStrikeX = ballPos.x + (goalToBallX / len) * 2.5;
      const idealStrikeZ = ballPos.z + (goalToBallZ / len) * 2.5;
      
      const isAheadOfBall = botState.team === 'red' ? (botBody.position.z < ballPos.z - 0.5) : (botBody.position.z > ballPos.z + 0.5);

      if (isAheadOfBall) {
        // Loop around to get behind the ball without pushing it backwards
        targetZ = idealStrikeZ;
        targetX = idealStrikeX + (botBody.position.x > ballPos.x ? 3 : -3);
      } else {
        // We are behind the ball
        const distToIdeal = Math.sqrt(Math.pow(idealStrikeX - botBody.position.x, 2) + Math.pow(idealStrikeZ - botBody.position.z, 2));
        if (distToIdeal > 2.5) {
           // Move towards the ideal strike position to line up the shot
           targetX = idealStrikeX;
           targetZ = idealStrikeZ;
        } else {
           // Drive straight through the ball towards the goal
           targetX = ballPos.x;
           targetZ = ballPos.z;
        }
      }

      if (room.difficulty === 'easy' && !isFillBot) {
         targetX += (Math.random() - 0.5) * 2;
         targetZ += (Math.random() - 0.5) * 2;
      }
    } else {
      // Defender Logic
      const distToOwnGoal = Math.abs(ballPos.z - ownGoalZ);
      
      if (distToOwnGoal < 12) {
         // Danger zone: step out to intercept, staying between ball and goal
         targetZ = botState.team === 'red' ? Math.max(ballPos.z + 1, 14) : Math.min(ballPos.z - 1, -14);
         const trackingError = room.difficulty === 'easy' ? (Math.random() - 0.5) * 4 : 0;
         targetX = Math.max(-4, Math.min(4, ballPos.x + trackingError));
      } else {
         // Calm defending: stay deep in the goal, track ball loosely
         targetZ = botState.team === 'red' ? 17 : -17;
         if (isFillBot) {
            const timeSec = Date.now() / 1000;
            const botUniqueOffset = botBody.id * 10;
            targetX = Math.cos(timeSec * 0.3 + botUniqueOffset) * 2;
         } else {
            // Track ball X but dampen it so they stay calm and centered
            const trackingError = room.difficulty === 'easy' ? (Math.random() - 0.5) * 4 : 0;
            targetX = Math.max(-2, Math.min(2, ballPos.x * 0.3 + trackingError));
         }
      }
    }

      const dirX = targetX - botBody.position.x;
      const dirZ = targetZ - botBody.position.z;
      const dist = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;

      if (dist > 0.5) {
        // Reduce speed based on difficulty
        let speedMult = room.difficulty === 'easy' ? 0.4 : room.difficulty === 'medium' ? 0.75 : 1.0;
        if (isFillBot) speedMult = 1; // Fill bots walk very slowly
        input.x = (dirX / dist) * speedMult;
        input.z = (dirZ / dist) * speedMult;
      } else {
        input.x = 0;
        input.z = 0;
      }

      // Kicking logic
      input.kick = false; // Reset kick by default
      if (distToBall < 2.5) {
        const toGoalX = 0 - botBody.position.x;
        const toGoalZ = opponentGoalZ - botBody.position.z;
        
        const isBehindBall = botState.team === 'red' ? (botBody.position.z > ballPos.z - 0.5) : (botBody.position.z < ballPos.z + 0.5);
        const isDefenderClearing = !isAttacker && Math.abs(ballPos.z - ownGoalZ) < 12;

        if (isBehindBall || isDefenderClearing) {
          // Check if ball is between bot and own goal
          const toOwnGoalZ = ownGoalZ - ballPos.z;
          const toOpponentGoalZ = opponentGoalZ - ballPos.z;
          
          // Only kick if we are closer to the opponent's goal than our own goal,
          // or if the ball is not dangerously close to our own goal.
          const isFacingOwnGoal = Math.abs(toOwnGoalZ) < Math.abs(toOpponentGoalZ);
          
          if (isDefenderClearing || ((room.difficulty !== 'easy' || Math.random() > 0.4) && !isFacingOwnGoal)) {
            input.kick = true;
            // Add error to kick angle for easier difficulties
            const aimError = room.difficulty === 'easy' ? (Math.random() - 0.5) * 1.5 : room.difficulty === 'medium' ? (Math.random() - 0.5) * 0.5 : 0;
            
            if (isDefenderClearing && !isBehindBall) {
               // If clearing and not behind the ball, kick it sideways and away from goal
               const clearDirX = ballPos.x > 0 ? 1 : -1; // Kick towards the nearest wall
               const clearDirZ = botState.team === 'red' ? -1 : 1; // Kick towards opponent half
               input.cameraAngle = Math.atan2(-clearDirX, -clearDirZ) + aimError;
            } else {
               // Use -toGoalX and -toGoalZ so the kick direction is TOWARDS the goal
               input.cameraAngle = Math.atan2(-toGoalX, -toGoalZ) + aimError;
            }
          }
        }
      }

      // Random jumps for Hard difficulty (prevent fill bots from jumping)
      if (room.difficulty === 'hard' && Math.random() < 0.01 && botBody.position.y < 1.1 && !isFillBot) {
        input.jump = true;
      } else {
        input.jump = false;
      }
    }
}

async function startServer() {
  const app = express();

  // Security Middlewares
  app.set("trust proxy", 1); // Trust first proxy (Render/Vercel)

  app.use(cors({
    origin: "*",
    methods: ["GET", "POST"]
  }));

  const server = http.createServer(app);
  const io = new SocketIOServer(server, { 
    cors: { 
      origin: "*",
      methods: ["GET", "POST"]
    } 
  });

  const playerRooms = new Map<string, string>(); // socket.id -> roomId
  const matchmakingQueue: { id: string, time: number }[] = [];
  const worldCupQueue: { id: string, time: number }[] = [];

  const freePlayRoom = createRoom('FREEPLAY', false);
  freePlayRoom.gameState.matchState = 'freeplay';
  freePlayRoom.gameState.message = 'FREE PLAY\nWAITING FOR PLAYERS...';
  rooms.set('FREEPLAY', freePlayRoom);

  const worldCupFreePlayRoom = createRoom('WORLD_CUP_FREEPLAY', false, false, 'medium', true);
  worldCupFreePlayRoom.gameState.matchState = 'freeplay';
  worldCupFreePlayRoom.gameState.message = 'WORLD CUP LOBBY\nWAITING FOR TOURNAMENT...';
  rooms.set('WORLD_CUP_FREEPLAY', worldCupFreePlayRoom);

  function leaveRoom(socket: import('socket.io').Socket) {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    
    const queueIndex = matchmakingQueue.findIndex(q => q.id === socket.id);
    if (queueIndex !== -1) matchmakingQueue.splice(queueIndex, 1);
    
    const wcQueueIndex = worldCupQueue.findIndex(q => q.id === socket.id);
    if (wcQueueIndex !== -1) worldCupQueue.splice(wcQueueIndex, 1);

    const room = rooms.get(roomId);
    if (!room) return;

    const leavingPlayerTeam = room.gameState.players[socket.id]?.team;

    if (room.playerBodies[socket.id]) {
      room.world.removeBody(room.playerBodies[socket.id]);
      delete room.playerBodies[socket.id];
    }
    delete room.playerInputs[socket.id];
    delete room.gameState.players[socket.id];
    
    socket.leave(roomId);
    io.to(roomId).emit("playerLeft", socket.id);
    playerRooms.delete(socket.id);

    const humanCount = Object.values(room.gameState.players).filter(p => !room.botIds.includes(p.id)).length;

    if (humanCount === 0 && roomId !== 'FREEPLAY' && roomId !== 'WORLD_CUP_FREEPLAY') {
      rooms.delete(roomId); // Clean up empty room
    } else if (roomId !== 'FREEPLAY' && roomId !== 'WORLD_CUP_FREEPLAY') {
      if (!room.isPrivate && !room.isTraining && leavingPlayerTeam) {
         addBot(room, leavingPlayerTeam, true);
      } else if (room.isPrivate || room.isTraining) {
        const blueCount = Object.values(room.gameState.players).filter(p => p.team === 'blue').length;
        const redCount = Object.values(room.gameState.players).filter(p => p.team === 'red').length;

        if ((room.gameState.matchState === 'playing' || room.gameState.matchState === 'countdown') && (blueCount === 0 || redCount === 0)) {
          room.gameState.matchState = 'gameover';
          if (blueCount === 0 && redCount > 0) {
            room.gameState.message = 'RED WINS (OPPONENT LEFT)!';
          } else if (redCount === 0 && blueCount > 0) {
            room.gameState.message = 'BLUE WINS (OPPONENT LEFT)!';
          } else {
            room.gameState.message = 'MATCH ENDED';
          }
          room.stateTimer = 5;
        }
      }
    }
  }

function joinRoom(socket: import('socket.io').Socket, room: Room, name: string, worldCupCountry?: string, character: string = 'robot') {
    socket.join(room.id);
    playerRooms.set(socket.id, room.id);

    const teamCount = Object.values(room.gameState.players).reduce(
      (acc, p) => { acc[p.team]++; return acc; },
      { red: 0, blue: 0 }
    );
    const team = teamCount.red <= teamCount.blue ? 'red' : 'blue';
    const color = team === 'red' ? '#ff007f' : '#00ffff';
    const startZ = team === 'red' ? 10 : -10;

    if (room.isWorldCup && worldCupCountry) {
      if (!room.gameState.worldCupTeams) {
        room.gameState.worldCupTeams = { red: '', blue: '' };
      }
      if (!room.gameState.worldCupTeams[team]) {
        room.gameState.worldCupTeams[team] = worldCupCountry;
      }
    }

    const playerBody = createPlayerBody(character, startZ, room.playerMaterial);
    room.world.addBody(playerBody);
    room.playerBodies[socket.id] = playerBody;
    room.playerInputs[socket.id] = { x: 0, z: 0, kick: false, jump: false, cameraAngle: 0 };

    room.gameState.players[socket.id] = {
      id: socket.id,
      name: name || `Player ${socket.id.substring(0, 4)}`,
      position: [playerBody.position.x, playerBody.position.y, playerBody.position.z],
      velocity: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      color,
      team,
      score: 0,
      lastKickTime: 0,
      lastJumpTime: 0,
      character,
      goals: 0,
      assists: 0,
      kicks: 0,
      worldCupCountry,
    };

    socket.emit("init", { id: socket.id, state: room.gameState, roomId: room.id, isPrivate: room.isPrivate });
    socket.to(room.id).emit("playerJoined", room.gameState.players[socket.id]);
  }

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("joinQueue", ({ name, worldCupCountry, isWorldCup, character }: { name: string, worldCupCountry?: string, isWorldCup?: boolean, character?: string }) => {
      leaveRoom(socket);
      
      const queue = isWorldCup ? worldCupQueue : matchmakingQueue;
      
      // 1. Try to find an existing public match with space
      let targetRoom: Room | null = null;
      for (const room of rooms.values()) {
        if (room.id !== 'FREEPLAY' && room.id !== 'WORLD_CUP_FREEPLAY' && !room.isPrivate && !room.isTraining && room.isWorldCup === !!isWorldCup) {
          const humanCount = Object.values(room.gameState.players).filter(p => !room.botIds.includes(p.id)).length;
          const maxPlayers = isWorldCup ? 2 : 4;
          if (humanCount < maxPlayers && room.gameState.matchState !== 'gameover') {
            targetRoom = room;
            break;
          }
        }
      }

      if (targetRoom) {
        console.log(`Filling existing ${isWorldCup ? 'World Cup ' : ''}room ${targetRoom.id} with player ${socket.id}`);
        const playerCount = Object.keys(targetRoom.gameState.players).length;
        const maxPlayers = isWorldCup ? 2 : 4;
        if (playerCount >= maxPlayers && targetRoom.botIds.length > 0) {
          const botIdToRemove = targetRoom.botIds.pop()!;
          targetRoom.world.removeBody(targetRoom.playerBodies[botIdToRemove]);
          delete targetRoom.playerBodies[botIdToRemove];
          delete targetRoom.playerInputs[botIdToRemove];
          delete targetRoom.gameState.players[botIdToRemove];
        }
        joinRoom(socket, targetRoom, name, worldCupCountry, character);
      } else {
        // 2. Fallback to Freeplay + Queue
        const fpRoom = isWorldCup ? worldCupFreePlayRoom : freePlayRoom;
        joinRoom(socket, fpRoom, name, worldCupCountry, character);
        queue.push({ id: socket.id, time: Date.now() });
      }
    });

    socket.on("createPrivateRoom", ({ name, worldCupCountry, isWorldCup, character }: { name: string, worldCupCountry?: string, isWorldCup?: boolean, character?: string }) => {
      leaveRoom(socket);
      const newRoomId = generateRoomCode();
      const room = createRoom(newRoomId, true, false, 'medium', !!isWorldCup);
      room.gameState.matchState = 'freeplay';
      room.gameState.message = `ROOM: ${newRoomId}\nWAITING FOR PLAYERS...`;
      rooms.set(newRoomId, room);
      joinRoom(socket, room, name, worldCupCountry, character);
      socket.emit("roomCreated", newRoomId);
    });

    socket.on("startTraining", ({ name, difficulty, worldCupCountry, isWorldCup, character }: { name: string, difficulty: 'easy' | 'medium' | 'hard', worldCupCountry?: string, isWorldCup?: boolean, character?: string }) => {
      leaveRoom(socket);
      const trainingRoomId = `TRAIN_${generateRoomCode()}`;
      const room = createRoom(trainingRoomId, true, true, difficulty, !!isWorldCup);
      rooms.set(trainingRoomId, room);
      
      // Join the human player
      joinRoom(socket, room, name, worldCupCountry, character);
      
      // Add the bot to the opposite team
      const humanPlayer = room.gameState.players[socket.id];
      const botTeam = humanPlayer.team === 'red' ? 'blue' : 'red';
      addBot(room, botTeam);
      
      socket.emit("roomCreated", trainingRoomId);
    });

    socket.on("joinPrivateRoom", ({ name, roomCode, worldCupCountry, character }: { name: string, roomCode: string, worldCupCountry?: string, character?: string }) => {
      leaveRoom(socket);
      const room = rooms.get(roomCode.toUpperCase());
      if (room && room.isPrivate && Object.keys(room.gameState.players).length < 4) {
        joinRoom(socket, room, name, worldCupCountry, character);
        if (room.gameState.matchState === 'freeplay' && room.id !== 'FREEPLAY') {
          room.gameState.message = `ROOM: ${room.id}\nWAITING FOR PLAYERS...`;
        }
      } else {
        socket.emit("error", "Room not found or full");
      }
    });

    socket.on("leave", () => {
      leaveRoom(socket);
    });

    socket.on("input", (input: { x: number; z: number; kick: boolean; jump: boolean; cameraAngle: number }) => {
      const roomId = playerRooms.get(socket.id);
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.playerInputs[socket.id] = input;
        }
      }
    });

    socket.on("chat", (message: string) => {
      if (message.length > 100) return;
      const roomId = playerRooms.get(socket.id);
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          const player = room.gameState.players[socket.id];
          if (player) {
            io.to(roomId).emit("chat", {
              id: Date.now().toString(),
              playerId: socket.id,
              playerName: player.name,
              playerColor: player.color,
              message,
              timestamp: Date.now(),
            });
          }
        }
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      leaveRoom(socket);
    });
  });

  // Physics Loop
  setInterval(() => {
    // Matchmaking check: Try to fill existing rooms first
    const processQueue = (queue: { id: string, time: number }[], isWorldCup: boolean) => {
      if (queue.length > 0) {
        const now = Date.now();
        const playersToRemove: string[] = [];
        
        const queueCopy = [...queue];
        for (let i = 0; i < queueCopy.length; i++) {
          const { id: pid, time } = queueCopy[i];
          const s = io.sockets.sockets.get(pid);
          if (!s) {
            playersToRemove.push(pid);
            continue;
          }

          // Try to find a room for this queued player
          let targetRoom: Room | null = null;
          for (const room of rooms.values()) {
            if (room.id !== 'FREEPLAY' && room.id !== 'WORLD_CUP_FREEPLAY' && !room.isPrivate && !room.isTraining && room.isWorldCup === isWorldCup) {
              const humanCount = Object.values(room.gameState.players).filter(p => !room.botIds.includes(p.id)).length;
              const maxPlayers = isWorldCup ? 2 : 4;
              if (humanCount < maxPlayers && room.gameState.matchState !== 'gameover') {
                targetRoom = room;
                break;
              }
            }
          }

          if (targetRoom) {
            const sourceRoom = isWorldCup ? worldCupFreePlayRoom : freePlayRoom;
            const name = sourceRoom.gameState.players[pid]?.name || 'Player';
            const worldCupCountry = sourceRoom.gameState.players[pid]?.worldCupCountry;
            const character = sourceRoom.gameState.players[pid]?.character || 'robot';
            leaveRoom(s);
            
            // If room is full of bots, remove a bot to make space
            const playerCount = Object.keys(targetRoom.gameState.players).length;
            const maxPlayers = isWorldCup ? 2 : 4;
            if (playerCount >= maxPlayers && targetRoom.botIds.length > 0) {
              const botIdToRemove = targetRoom.botIds.pop()!;
              targetRoom.world.removeBody(targetRoom.playerBodies[botIdToRemove]);
              delete targetRoom.playerBodies[botIdToRemove];
              delete targetRoom.playerInputs[botIdToRemove];
              delete targetRoom.gameState.players[botIdToRemove];
            }

            joinRoom(s, targetRoom, name, worldCupCountry, character);
            playersToRemove.push(pid);
          } else if (now - time > 5000) {
            // Wait 10 seconds, then create a room with bots
            const matchRoomId = generateRoomCode();
            const matchRoom = createRoom(matchRoomId, false, false, 'medium', isWorldCup);
            rooms.set(matchRoomId, matchRoom);

            const sourceRoom = isWorldCup ? worldCupFreePlayRoom : freePlayRoom;
            const name = sourceRoom.gameState.players[pid]?.name || 'Player';
            const worldCupCountry = sourceRoom.gameState.players[pid]?.worldCupCountry;
            const character = sourceRoom.gameState.players[pid]?.character || 'robot';
            leaveRoom(s);
            joinRoom(s, matchRoom, name, worldCupCountry, character);
            
            // Fill with bots
            const maxPlayers = isWorldCup ? 2 : 4;
            for (let j = 1; j < maxPlayers; j++) {
               const teamCount = Object.values(matchRoom.gameState.players).reduce(
                 (acc, p) => { acc[p.team]++; return acc; },
                 { red: 0, blue: 0 }
               );
               const botTeam = teamCount.red <= teamCount.blue ? 'red' : 'blue';
               addBot(matchRoom, botTeam, true);
            }

            playersToRemove.push(pid);
          }
        }

        // Clean up queue
        for (const pid of playersToRemove) {
          const idx = queue.findIndex(q => q.id === pid);
          if (idx !== -1) queue.splice(idx, 1);
        }
      }

      // If still have enough for a new match without waiting 10s
      if (queue.length >= 2) {
        const p1 = queue.shift()!;
        const p2 = queue.shift()!;
        
        const matchRoomId = generateRoomCode();
        const matchRoom = createRoom(matchRoomId, false, false, 'medium', isWorldCup);
        rooms.set(matchRoomId, matchRoom);

        const playersToMove = [p1.id, p2.id];
        const sourceRoom = isWorldCup ? worldCupFreePlayRoom : freePlayRoom;
        for (const pid of playersToMove) {
          const s = io.sockets.sockets.get(pid);
          if (s) {
            const name = sourceRoom.gameState.players[pid]?.name || 'Player';
            const worldCupCountry = sourceRoom.gameState.players[pid]?.worldCupCountry;
            const character = sourceRoom.gameState.players[pid]?.character || 'robot';
            leaveRoom(s);
            joinRoom(s, matchRoom, name, worldCupCountry, character);
          }
        }
        
        // If it's a 4 player match and we only have 2, fill the rest with bots
        if (!isWorldCup) {
            for (let j = 2; j < 4; j++) {
               const teamCount = Object.values(matchRoom.gameState.players).reduce(
                 (acc, p) => { acc[p.team]++; return acc; },
                 { red: 0, blue: 0 }
               );
               const botTeam = teamCount.red <= teamCount.blue ? 'red' : 'blue';
               addBot(matchRoom, botTeam, true);
            }
        }
      }
    };

    processQueue(matchmakingQueue, false);
    processQueue(worldCupQueue, true);

    for (const room of rooms.values()) {
      room.ticks++;
      
      // Update AI
      if (room.botIds.length > 0) {
        updateBots(room);
      }

      if (room.ticks >= TICK_RATE) {
        room.ticks = 0;
        
        if (room.gameState.matchState === 'waiting' || (room.gameState.matchState === 'freeplay' && room.id !== 'FREEPLAY')) {
          if (Object.keys(room.gameState.players).length >= 2) {
            room.gameState.matchState = 'countdown';
            room.gameState.timer = 5;
            room.gameState.message = '';
            room.gameState.score = { red: 0, blue: 0 };
            room.gameState.isOvertime = false;
            delete room.gameState.lastScorer;
            room.resetPositions();
          }
        } else if (room.gameState.matchState === 'countdown') {
          room.gameState.timer--;
          if (room.gameState.timer <= 0) {
            room.gameState.matchState = 'playing';
            room.gameState.timer = 180;
            room.gameState.isOvertime = false;
          }
        } else if (room.gameState.matchState === 'playing') {
          room.gameState.timer--;
          if (room.gameState.timer <= 0) {
            if (room.gameState.score.blue === room.gameState.score.red && !room.gameState.isOvertime) {
              // Start Overtime
              room.gameState.isOvertime = true;
              room.gameState.timer = 60; // 1 minute overtime
              room.gameState.message = 'OVERTIME!';
            } else {
              room.gameState.matchState = 'gameover';
              const winner: 'red' | 'blue' | 'draw' = room.gameState.score.blue > room.gameState.score.red ? 'blue' : (room.gameState.score.red > room.gameState.score.blue ? 'red' : 'draw');
              if (winner === 'blue') {
                room.gameState.message = 'BLUE WINS!';
              } else if (winner === 'red') {
                room.gameState.message = 'RED WINS!';
              } else {
                room.gameState.message = 'DRAW!';
              }

              // Reward players
              for (const id in room.gameState.players) {
                const player = room.gameState.players[id];
                const socket = io.sockets.sockets.get(id);
                if (socket && !id.startsWith('bot-')) {
                  const coins = winner === 'draw' ? 15 : (player.team === winner ? 35 : 5);
                  const exp = winner === 'draw' ? 5 : (player.team === winner ? 10 : 2);
                  socket.emit('reward', { coins, exp });
                }
              }
              room.stateTimer = 5;
            }
          }
        }
 else if (room.gameState.matchState === 'goal') {
          room.stateTimer--;
          if (room.stateTimer <= 0) {
            if (room.gameState.isOvertime) {
              room.gameState.matchState = 'gameover';
              const winner: 'red' | 'blue' = room.gameState.score.blue > room.gameState.score.red ? 'blue' : 'red';
              
              // Reward players
              for (const id in room.gameState.players) {
                const player = room.gameState.players[id];
                const socket = io.sockets.sockets.get(id);
                if (socket && !id.startsWith('bot-')) {
                  const coins = player.team === winner ? 35 : 5;
                  const exp = player.team === winner ? 10 : 2;
                  socket.emit('reward', { coins, exp });
                }
              }
              room.stateTimer = 5;
            } else {
              room.resetPositions();
              room.gameState.matchState = 'playing';
              room.gameState.message = '';
              delete room.gameState.lastScorer;
            }
          }
        } else if (room.gameState.matchState === 'gameover') {
          room.stateTimer--;
          if (room.stateTimer <= 0) {
            io.to(room.id).emit('matchEnded');
            if (room.id !== 'FREEPLAY') {
              room.gameState.matchState = 'freeplay';
              room.gameState.message = `ROOM: ${room.id}\nWAITING FOR PLAYERS...`;
            } else {
              room.gameState.matchState = 'waiting';
              room.gameState.message = 'Waiting for players...';
            }
            room.gameState.score = { red: 0, blue: 0 };
            room.gameState.isOvertime = false;
            delete room.gameState.lastScorer;
            room.resetPositions();
          }
        }
      }

      if (room.gameState.matchState === 'playing' || room.gameState.matchState === 'freeplay') {
        const speed = 15;
        const acceleration = 100;
        for (const id in room.playerInputs) {
          const input = room.playerInputs[id];
          const body = room.playerBodies[id];
          if (body) {
            const targetVelX = input.x * speed;
            const targetVelZ = input.z * speed;
            
            const forceX = (targetVelX - body.velocity.x) * acceleration;
            const forceZ = (targetVelZ - body.velocity.z) * acceleration;
            
            body.applyForce(new CANNON.Vec3(forceX, 0, forceZ), body.position);
            
            // Update physics body rotation to face movement direction so the flat bumper works
            if (Math.abs(body.velocity.x) > 0.1 || Math.abs(body.velocity.z) > 0.1) {
              const angle = Math.atan2(body.velocity.x, body.velocity.z);
              body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), angle);
            }
            
            if (input.jump) {
              if (body.position.y <= 1.1) {
                body.velocity.y = 10; // Increased initial jump velocity
                const state = room.gameState.players[id];
                if (state) state.lastJumpTime = Date.now();
              }
              input.jump = false;
            }

            // Refine jump gravity: apply extra downward force when in the air
            if (body.position.y > 1.1) {
              // Apply more gravity when falling for a snappier feel
              const extraGravity = body.velocity.y < 0 ? -25 : -15;
              body.applyForce(new CANNON.Vec3(0, extraGravity * body.mass, 0), body.position);
            }

            if (input.kick) {
              const distance = body.position.distanceTo(room.ballBody.position);
              if (distance < 2.2) {
                const angle = input.cameraAngle || 0;
                const dir = new CANNON.Vec3(-Math.sin(angle), 0.3, -Math.cos(angle));
                dir.normalize();
                
                const kickSpeed = 18;
                room.ballBody.velocity.set(dir.x * kickSpeed, dir.y * kickSpeed, dir.z * kickSpeed);
                
                const state = room.gameState.players[id];
                if (state) {
                  state.lastKickTime = Date.now();
                  state.kicks++;
                  
                  if (room.lastTouchId !== id) {
                    room.secondLastTouchId = room.lastTouchId;
                    room.lastTouchId = id;
                  }
                }
              }
              input.kick = false; 
            } else {
              const distance = body.position.distanceTo(room.ballBody.position);
              if (distance < 1.8 && (Math.abs(body.velocity.x) > 0.1 || Math.abs(body.velocity.z) > 0.1)) {
                const dribbleForce = new CANNON.Vec3(body.velocity.x, 0, body.velocity.z);
                dribbleForce.normalize();
                dribbleForce.y = -0.1;
                room.ballBody.applyForce(dribbleForce.scale(5), room.ballBody.position);

                if (room.lastTouchId !== id) {
                  room.secondLastTouchId = room.lastTouchId;
                  room.lastTouchId = id;
                }
              }
            }

            // Prevent standing on the ball (make them slip off)
            const dx = body.position.x - room.ballBody.position.x;
            const dz = body.position.z - room.ballBody.position.z;
            const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
            if (body.position.y > room.ballBody.position.y + 0.4 && horizontalDistance < 1.2) {
              const pushDir = new CANNON.Vec3(dx, 0, dz);
              if (pushDir.length() < 0.1) {
                // If perfectly centered, pick a random direction to slip
                const angle = Math.random() * Math.PI * 2;
                pushDir.set(Math.cos(angle), 0, Math.sin(angle));
              }
              pushDir.normalize();
              
              // The closer to the center, the stronger the slip (unstable equilibrium)
              const slipFactor = Math.max(0.1, 1.5 - horizontalDistance);
              
              // Push the player off the ball
              body.applyForce(pushDir.scale(300 * slipFactor), body.position);
              
              // Squeeze the ball out from under the player
              room.ballBody.applyForce(pushDir.scale(-400 * slipFactor), room.ballBody.position);
              
              // Add some spin to the ball to make it roll out naturally
              room.ballBody.angularVelocity.set(pushDir.z * 15, 0, -pushDir.x * 15);
            }

            // Prevent standing on other players
            for (const otherId in room.playerBodies) {
              if (id !== otherId) {
                const otherBody = room.playerBodies[otherId];
                const pdx = body.position.x - otherBody.position.x;
                const pdz = body.position.z - otherBody.position.z;
                const pHorizontalDistance = Math.sqrt(pdx * pdx + pdz * pdz);
                
                // If this player is significantly higher and horizontally close
                if (body.position.y > otherBody.position.y + 0.5 && pHorizontalDistance < 1.2) {
                  const pushDir = new CANNON.Vec3(pdx, 0, pdz);
                  if (pushDir.length() < 0.1) {
                    const angle = Math.random() * Math.PI * 2;
                    pushDir.set(Math.cos(angle), 0, Math.sin(angle));
                  }
                  pushDir.normalize();
                  
                  const slipFactor = Math.max(0.5, 1.5 - pHorizontalDistance);
                  
                  // Teleport slightly to break perfect stacking
                  body.position.x += pushDir.x * 0.1;
                  body.position.z += pushDir.z * 0.1;

                  // Apply extreme velocity to force them off instantly
                  body.velocity.x = pushDir.x * 15 * slipFactor;
                  body.velocity.z = pushDir.z * 15 * slipFactor;
                  body.velocity.y = -10; // Force them downward
                  
                  // Push the bottom player slightly in the opposite direction
                  otherBody.velocity.x -= pushDir.x * 5 * slipFactor;
                  otherBody.velocity.z -= pushDir.z * 5 * slipFactor;
                }
              }
            }
          }
        }
      } else {
        for (const id in room.playerBodies) {
          room.playerBodies[id].velocity.set(0, 0, 0);
        }
      }

      room.world.step(TICK_DT);

      const maxBallSpeed = 25;
      const currentSpeed = room.ballBody.velocity.length();
      if (currentSpeed > maxBallSpeed) {
        room.ballBody.velocity.scale(maxBallSpeed / currentSpeed, room.ballBody.velocity);
      }

      if (room.gameState.matchState === 'playing' || room.gameState.matchState === 'freeplay') {
        const goalWidth = 8;
        const goalHeight = 3.6;
        const ballRadius = 0.5;
        
        const isInsideWidth = Math.abs(room.ballBody.position.x) < (goalWidth / 2);
        const isBelowHeight = room.ballBody.position.y < goalHeight;

        if (isInsideWidth && isBelowHeight) {
          if (room.ballBody.position.z > 40 / 2 + ballRadius) {
            if (room.gameState.matchState === 'playing') {
              room.gameState.score.blue++;
              
              if (room.gameState.isOvertime) {
                room.gameState.matchState = 'gameover';
                room.gameState.message = 'BLUE WINS!';
                room.stateTimer = 5;
              } else {
                room.gameState.matchState = 'goal';
                room.gameState.message = 'BLUE SCORES!';
                room.stateTimer = 3;
              }

              // Stats
              if (room.lastTouchId) {
                const scorer = room.gameState.players[room.lastTouchId];
                if (scorer) {
                  if (scorer.team === 'blue') {
                    scorer.goals++;
                  }
                  room.gameState.lastScorer = {
                    name: scorer.name,
                    team: scorer.team,
                    country: scorer.worldCupCountry
                  };
                  if (room.secondLastTouchId) {
                    const assistant = room.gameState.players[room.secondLastTouchId];
                    if (assistant && assistant.team === 'blue' && assistant.id !== scorer.id) {
                      assistant.assists++;
                    }
                  }
                }
              }
              room.lastTouchId = null;
              room.secondLastTouchId = null;

              io.to(room.id).emit("goal", { team: 'blue', score: room.gameState.score });
            } else {
              room.ballBody.position.set(0, 5, 0);
              room.ballBody.velocity.set(0, 0, 0);
              room.ballBody.angularVelocity.set(0, 0, 0);
            }
          } else if (room.ballBody.position.z < -40 / 2 - ballRadius) {
            if (room.gameState.matchState === 'playing') {
              room.gameState.score.red++;
              
              if (room.gameState.isOvertime) {
                room.gameState.matchState = 'gameover';
                room.gameState.message = 'RED WINS!';
                room.stateTimer = 5;
              } else {
                room.gameState.matchState = 'goal';
                room.gameState.message = 'RED SCORES!';
                room.stateTimer = 3;
              }

              // Stats
              if (room.lastTouchId) {
                const scorer = room.gameState.players[room.lastTouchId];
                if (scorer) {
                  if (scorer.team === 'red') {
                    scorer.goals++;
                  }
                  room.gameState.lastScorer = {
                    name: scorer.name,
                    team: scorer.team,
                    country: scorer.worldCupCountry
                  };
                  if (room.secondLastTouchId) {
                    const assistant = room.gameState.players[room.secondLastTouchId];
                    if (assistant && assistant.team === 'red' && assistant.id !== scorer.id) {
                      assistant.assists++;
                    }
                  }
                }
              }
              room.lastTouchId = null;
              room.secondLastTouchId = null;

              io.to(room.id).emit("goal", { team: 'red', score: room.gameState.score });
            } else {
              room.ballBody.position.set(0, 5, 0);
              room.ballBody.velocity.set(0, 0, 0);
              room.ballBody.angularVelocity.set(0, 0, 0);
            }
          }
        }
      }

      room.gameState.ball.position = [room.ballBody.position.x, room.ballBody.position.y, room.ballBody.position.z];
      room.gameState.ball.velocity = [room.ballBody.velocity.x, room.ballBody.velocity.y, room.ballBody.velocity.z];
      room.gameState.ball.rotation = [room.ballBody.quaternion.x, room.ballBody.quaternion.y, room.ballBody.quaternion.z, room.ballBody.quaternion.w];

      for (const id in room.playerBodies) {
        const body = room.playerBodies[id];
        const state = room.gameState.players[id];
        if (state) {
          state.position = [body.position.x, body.position.y, body.position.z];
          state.velocity = [body.velocity.x, body.velocity.y, body.velocity.z];
          
          if (Math.abs(body.velocity.x) > 0.1 || Math.abs(body.velocity.z) > 0.1) {
            const angle = Math.atan2(body.velocity.x, body.velocity.z);
            const quat = new CANNON.Quaternion();
            quat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), angle);
            state.rotation = [quat.x, quat.y, quat.z, quat.w];
          }
        }
      }

      io.to(room.id).emit("update", room.gameState);
    }
  }, 1000 / TICK_RATE);

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    const indexPath = path.join(distPath, "index.html");
    
    if (fs.existsSync(indexPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(indexPath);
      });
    } else {
      app.get("/", (req, res) => {
        res.json({ 
          message: "Soccer Rivals 3D Backend is running.", 
          status: "healthy",
          serverTime: new Date().toISOString()
        });
      });
    }
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running in ${process.env.NODE_ENV === "production" ? "production" : "development"} mode on port ${PORT}`);
  });
}

startServer();


/**
 * @copyright 2026 hentertrabelsi - All Rights Reserved
 */
