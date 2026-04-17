import express from 'express';
import { createServer as createHttpServer } from 'http';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Setup SQLite Database
const db = new Database(path.join(process.cwd(), 'database.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS instructions (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL,
    name TEXT NOT NULL,
    media_url TEXT,
    media_type TEXT,
    bg_color TEXT DEFAULT 'bg-slate-900',
    order_index INTEGER DEFAULT 0,
    FOREIGN KEY (scenario_id) REFERENCES scenarios (id) ON DELETE CASCADE
  );
`);

// Setup Multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(process.cwd(), 'uploads'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

async function startServer() {
  const app = express();
  const httpServer = createHttpServer(app);
  const io = new Server(httpServer);
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  // --- API Routes ---

  // Get all scenarios
  app.get('/api/scenarios', (req, res) => {
    const scenarios = db.prepare('SELECT * FROM scenarios ORDER BY created_at DESC').all();
    res.json(scenarios);
  });

  // Create a scenario
  app.post('/api/scenarios', (req, res) => {
    const { id, name, stepsCount } = req.body;
    
    const insertScenario = db.prepare('INSERT INTO scenarios (id, name) VALUES (?, ?)');
    insertScenario.run(id, name);

    const insertInstruction = db.prepare('INSERT INTO instructions (id, scenario_id, name, order_index) VALUES (?, ?, ?, ?)');
    
    // Create initial steps
    for (let i = 0; i < stepsCount; i++) {
      const instId = crypto.randomUUID();
      insertInstruction.run(instId, id, `Étape ${i + 1}`, i);
    }

    res.json({ success: true, id });
  });

  // Delete a scenario
  app.delete('/api/scenarios/:id', (req, res) => {
    db.prepare('DELETE FROM scenarios WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Get instructions for a scenario
  app.get('/api/scenarios/:id/instructions', (req, res) => {
    const instructions = db.prepare('SELECT * FROM instructions WHERE scenario_id = ? ORDER BY order_index ASC').all(req.params.id);
    res.json(instructions);
  });

  // Create an instruction
  app.post('/api/scenarios/:id/instructions', (req, res) => {
    const { id, name, order_index } = req.body;
    const scenarioId = req.params.id;
    
    db.prepare('INSERT INTO instructions (id, scenario_id, name, order_index) VALUES (?, ?, ?, ?)')
      .run(id, scenarioId, name, order_index);
      
    res.json({ success: true });
  });

  // Update an instruction (including media upload)
  app.put('/api/instructions/:id', upload.single('media'), (req, res) => {
    const { name, remove_media } = req.body;
    const id = req.params.id;
    
    if (remove_media === 'true') {
      db.prepare('UPDATE instructions SET name = ?, media_url = NULL, media_type = NULL WHERE id = ?')
        .run(name, id);
    } else if (req.file) {
      const mediaUrl = `/uploads/${req.file.filename}`;
      const mediaType = req.file.mimetype;
      db.prepare('UPDATE instructions SET name = ?, media_url = ?, media_type = ? WHERE id = ?')
        .run(name, mediaUrl, mediaType, id);
    } else {
      db.prepare('UPDATE instructions SET name = ? WHERE id = ?')
        .run(name, id);
    }
    
    res.json({ success: true });
  });

  // Delete an instruction
  app.delete('/api/instructions/:id', (req, res) => {
    db.prepare('DELETE FROM instructions WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // --- WebSockets (Real-time Communication) ---
  
  let patientSocketId: string | null = null;

  io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('register_role', (role) => {
      if (role === 'patient') {
        patientSocketId = socket.id;
        console.log('Patient screen registered');
        // Notify all staff that patient is connected
        io.emit('patient_status', { connected: true });
      } else if (role === 'staff') {
        console.log('Staff console registered');
        // Tell the newly connected staff if the patient is already there
        socket.emit('patient_status', { connected: patientSocketId !== null });
      }
    });

    socket.on('send_instruction', (instruction) => {
      // Broadcast the instruction to the patient screen
      io.emit('play_instruction', instruction);
    });

    socket.on('clear_instruction', () => {
      io.emit('clear_instruction');
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      if (socket.id === patientSocketId) {
        patientSocketId = null;
        console.log('Patient screen disconnected');
        io.emit('patient_status', { connected: false });
      }
    });
  });

  // --- Vite Middleware for Development/Production ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
