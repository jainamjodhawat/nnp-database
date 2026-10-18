# 🛕 Yatra Desk (यात्रा डेस्क)

A complete, production-ready pilgrimage management and registration web application. It features real-time analytics, Excel/CSV sheet ingestion, smart duplicate pilgrim detection, payment tracking, check-ins, and **rock-solid persistent storage** backed by SQLite and automated JSON snapshots.

---

## ✨ Features

- **No Changes to UX/UI**: The exact visual layout, tabs, charts, color palette, and workflows you love are 100% preserved.
- **Persistent Data Storage**: All trips, pilgrims, check-ins, payments, and notes are automatically saved to a persistent SQLite database (`data/yatra.db`) with an auto-synced JSON backup (`data/yatra.json`).
- **Live Cross-Device Sync**: Real-time Server-Sent Events (SSE) update all connected browsers and phones automatically when changes are made.
- **Offline / Local Fallback**: Seamless fallback to browser storage if accessed without an internet connection or standalone.
- **Direct CSV Exports**: Export participants and registries to clean CSV files directly in standard web browsers.
- **Ready for Deployment**: Includes production configurations for **Render**, **Railway**, **Fly.io**, and **Docker**.

---

## 🚀 Quick Start (Local)

### Prerequisites
- Node.js (version 18 or newer; Node 20 or Node 22+ recommended)

### 1. Install & Run
In this folder, run:
```bash
npm install
npm start
```
Or on Windows, simply double-click **`start.bat`**.

### 2. Open in Browser
Visit:
```
http://localhost:3000
```
The status pill in the top bar will show **Saved to shared store** with a green indicator, confirming all data is being continuously saved to your database.

---

## 📦 How Data Storage Works

1. **SQLite Database (`data/yatra.db`)**:
   - Uses Write-Ahead Logging (WAL) for speed and concurrency.
   - ACID-compliant: saves are transactional and crash-proof.
2. **Automated JSON Snapshot (`data/yatra.json`)**:
   - An atomic copy of all records is maintained simultaneously in human-readable JSON.
   - If SQLite is ever empty on a new server, it automatically bootstraps from `data/yatra.json`.
3. **Downloadable Backups**:
   - Access `http://localhost:3000/api/backup` in your browser anytime to download a timestamped snapshot of your entire database.

---

## 🌐 Deployment Options

### Option 1: Render.com (Recommended)
1. Push this repository to GitHub or GitLab.
2. Log in to [Render Dashboard](https://dashboard.render.com/) and click **New +** → **Blueprint** (or **Web Service**).
3. If using Blueprint, Render automatically detects [`render.yaml`](render.yaml) which configures:
   - Environment: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Persistent Disk mounted at `/var/data` (ensuring your database persists between redeploys).
4. Click **Create Web Service**. Your app is live!

---

### Option 2: Railway.app
1. Create a new project in [Railway.app](https://railway.app/).
2. Select **Deploy from GitHub repo** and choose your repository.
3. In service settings:
   - Go to **Volumes** → **Add Volume**.
   - Set the mount path to `/app/data`.
4. Railway will deploy your app with persistent storage enabled.

---

### Option 3: Docker / Docker Compose
Deploy on any server with Docker installed:

```bash
docker-compose up -d --build
```
Your app will be accessible on port `3000`. All database files persist in the `./data` directory on the host machine.

To stop the container:
```bash
docker-compose down
```

---

### Option 4: Linux / Ubuntu VPS (PM2 or systemd)
1. Clone the project onto your server:
   ```bash
   git clone <your-repo-url>
   cd final
   npm install --production
   ```
2. Start with PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name "yatra-desk"
   pm2 save
   pm2 startup
   ```
3. (Optional) Put Nginx in front with SSL (Let's Encrypt Certbot) reverse-proxying to `http://127.0.0.1:3000`.

---

## 📡 API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/data` | `GET` | Fetches complete database (`trips`, `people`, `regs`) |
| `/api/save` | `POST` | Atomically commits changes and broadcasts live sync |
| `/api/events` | `GET` | Server-Sent Events (SSE) stream for live updates |
| `/api/backup` | `GET` | Downloads timestamped JSON database backup |
| `/api/backup/restore` | `POST` | Restores database from a JSON backup payload |
| `/api/health` | `GET` | System health check, uptime, and record statistics |

---

## 📂 Project Structure

```
final/
├── public/
│   └── index.html          # Frontend web app (persisted, zero UI changes)
├── data/
│   ├── yatra.db            # SQLite database with WAL mode
│   └── yatra.json          # Live atomic JSON backup snapshot
├── db.js                   # Storage persistence layer (SQLite + JSON)
├── server.js               # Express backend API & static server
├── package.json            # Project dependencies & scripts
├── Dockerfile              # Container deployment
├── docker-compose.yml      # 1-command Docker deployment
├── render.yaml             # Render.com Blueprint configuration
├── .env.example            # Environment variables template
├── start.bat               # 1-click Windows launcher
└── Yatra_Desk_local.html   # Preserved standalone file
```
