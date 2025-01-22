import { createServer } from 'http';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';

const httpServer = createServer();

// 添加健康检查路由
httpServer.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }
});

const io = new Server(httpServer, {
  cors: {
    origin: '*',  // 允许所有来源
    methods: ["GET", "POST"]
  },
  transports: ['websocket']
});

// 游戏常量
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const BLOCK_SIZE = 20;
const GAME_SPEED = 15;

// 颜色
const COLORS = {
  GREEN: '#00FF00',
  BLUE: '#0000FF',
  RED: '#FF0000',
};

// 方向
const Direction = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
} as const;

type Position = { x: number; y: number };
type Direction = typeof Direction[keyof typeof Direction];

class GameRoom {
  id: string;
  players: string[] = [];
  gameState: {
    snake1: any;
    snake2: any;
    food: any;
    lastUpdate: number;
  };
  gameLoop: NodeJS.Timeout | null = null;

  constructor() {
    this.id = randomUUID();
    this.gameState = this.initializeGameState();
  }

  initializeGameState() {
    return {
      snake1: {
        positions: [{ x: CANVAS_WIDTH / 4, y: CANVAS_HEIGHT / 2 }],
        direction: Direction.RIGHT,
        color: COLORS.GREEN,
        score: 0,
        speed: GAME_SPEED,
      },
      snake2: {
        positions: [{ x: (CANVAS_WIDTH * 3) / 4, y: CANVAS_HEIGHT / 2 }],
        direction: Direction.LEFT,
        color: COLORS.BLUE,
        score: 0,
        speed: GAME_SPEED,
      },
      food: this.generateFood(),
      lastUpdate: Date.now(),
    };
  }

  generateFood() {
    const position = {
      x: Math.floor(Math.random() * (CANVAS_WIDTH / BLOCK_SIZE)) * BLOCK_SIZE,
      y: Math.floor(Math.random() * (CANVAS_HEIGHT / BLOCK_SIZE)) * BLOCK_SIZE,
    };
    return {
      position,
      color: COLORS.RED,
    };
  }

  update() {
    const { snake1, snake2, food } = this.gameState;
    const now = Date.now();
    
    if (now - this.gameState.lastUpdate < 1000 / GAME_SPEED) {
      return;
    }

    // 更新蛇的位置
    [snake1, snake2].forEach(snake => {
      const head = snake.positions[0];
      const newHead = {
        x: (head.x + snake.direction.x * BLOCK_SIZE + CANVAS_WIDTH) % CANVAS_WIDTH,
        y: (head.y + snake.direction.y * BLOCK_SIZE + CANVAS_HEIGHT) % CANVAS_HEIGHT,
      };

      snake.positions.unshift(newHead);
      
      // 检查是否吃到食物
      if (newHead.x === food.position.x && newHead.y === food.position.y) {
        snake.score += 1;
        this.gameState.food = this.generateFood();
      } else {
        snake.positions.pop();
      }
    });

    // 检查碰撞
    const collision = this.checkCollision();
    if (collision) {
      this.resetGame();
    }

    this.gameState.lastUpdate = now;
  }

  checkCollision() {
    const { snake1, snake2 } = this.gameState;
    
    // 检查蛇头与身体碰撞
    const checkSelfCollision = (snake: any) => {
      const head = snake.positions[0];
      return snake.positions.slice(1).some((pos: Position) =>
        pos.x === head.x && pos.y === head.y
      );
    };

    // 检查蛇头与另一条蛇碰撞
    const checkSnakeCollision = () => {
      const head1 = snake1.positions[0];
      const head2 = snake2.positions[0];
      
      return snake2.positions.some((pos: Position) =>
        pos.x === head1.x && pos.y === head1.y
      ) || snake1.positions.some((pos: Position) =>
        pos.x === head2.x && pos.y === head2.y
      );
    };

    return checkSelfCollision(snake1) || checkSelfCollision(snake2) || checkSnakeCollision();
  }

  resetGame() {
    this.gameState = this.initializeGameState();
  }

  startGame() {
    if (this.gameLoop) return;
    
    this.gameLoop = setInterval(() => {
      this.update();
      io.to(this.id).emit('gameState', this.gameState);
    }, 1000 / 60);
  }

  stopGame() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
  }
}

const rooms = new Map<string, GameRoom>();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('createRoom', () => {
    const room = new GameRoom();
    rooms.set(room.id, room);
    socket.join(room.id);
    room.players.push(socket.id);
    socket.emit('roomCreated', room.id);
  });

  socket.on('joinRoom', (roomId: string) => {
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', '房间不存在');
      return;
    }
    
    if (room.players.length >= 2) {
      socket.emit('error', '房间已满');
      return;
    }

    socket.join(roomId);
    room.players.push(socket.id);
    io.to(roomId).emit('roomJoined');
    room.startGame();
  });

  socket.on('direction', (direction: Direction) => {
    // 找到玩家所在的房间
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.indexOf(socket.id);
      if (playerIndex !== -1) {
        // 更新对应玩家的蛇的方向
        const snake = playerIndex === 0 ? room.gameState.snake1 : room.gameState.snake2;
        const currentDir = snake.direction;
        
        // 防止反向移动
        if (
          (direction.x === 0 && currentDir.x === 0) ||
          (direction.y === 0 && currentDir.y === 0) ||
          (direction.x === -currentDir.x && direction.y === -currentDir.y)
        ) {
          return;
        }
        
        snake.direction = direction;
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    // 清理玩家所在的房间
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.indexOf(socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        room.stopGame();
        if (room.players.length === 0) {
          rooms.delete(roomId);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});