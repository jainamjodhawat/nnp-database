# 🛕 Yatra Desk (यात्रा डेस्क)

A complete, production-ready pilgrimage management and registration web application with **free cloud database support** (MongoDB Atlas or Supabase/PostgreSQL) and local fallback.

---

## ☁️ Free Cloud Database Setup

Your application now natively supports **Free Cloud Databases**, allowing your data to persist forever in the cloud and be accessed across all your devices, browsers, and deployment hosts.

### Option A: MongoDB Atlas (Recommended — 512MB Free Forever, No Credit Card)
1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) and create a free account.
2. Select the **M0 Free Cluster** (Shared).
3. Under **Database Access**, create a database user (e.g. `yatra_admin`) and a password.
4. Under **Network Access**, click **Add IP Address** → choose **Allow Access from Anywhere** (`0.0.0.0/0`).
5. Click **Connect** → **Drivers** (Node.js) → copy your connection string:
   ```
   mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority
   ```
6. Create or edit `.env` in this directory:
   ```env
   MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/yatra_desk?retryWrites=true&w=majority
   ```

### Option B: Supabase / Neon (Free PostgreSQL)
1. Go to [Supabase](https://supabase.com) or [Neon](https://neon.tech) and create a free project.
2. In Project Settings → **Database**, copy your **Connection String (URI)**.
3. In `.env`:
   ```env
   DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   ```

> **Automatic Cloud Migration**: When you connect to your cloud database for the first time, Yatra Desk automatically detects and migrates any existing local trips and pilgrims to the cloud database!

---

## 🚀 Quick Start (Local)

### 1. Install & Run
```bash
npm install
npm start
```
*(Or double-click **`start.bat`** on Windows)*

### 2. Open in Browser
Visit:
```
http://localhost:3000
```
When connected to your cloud database, the server console and API healthcheck will show:
`✓ Connected to Cloud Database: MongoDB Atlas` (or PostgreSQL).

---

## 🌐 Deploy to the Cloud (Render, Railway, Vercel, Fly.io)

Because your database is now in the cloud, you can deploy the app to **any free host** without needing persistent server disks!

### Deploy to Render.com
1. Push this folder to a GitHub repository.
2. In [Render Dashboard](https://dashboard.render.com/), click **New +** → **Web Service** → select your repo.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. In **Environment Variables**, add:
   - `MONGODB_URI` = `your-cloud-database-connection-string`
     *(or `DATABASE_URL`)*
6. Click **Deploy**. Your app will connect to your cloud database instantly!

### Deploy to Railway.app / Fly.io / Docker
Add the `MONGODB_URI` or `DATABASE_URL` environment variable in your dashboard or `.env`.

---

## 📡 API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/data` | `GET` | Fetches complete database from cloud (`trips`, `people`, `regs`) |
| `/api/save` | `POST` | Atomically commits changes to cloud DB & broadcasts live updates |
| `/api/events` | `GET` | Server-Sent Events (SSE) stream for instant cross-device updates |
| `/api/backup` | `GET` | Downloads timestamped JSON snapshot of your entire database |
| `/api/backup/restore` | `POST` | Restores database from a JSON backup payload |
| `/api/health` | `GET` | System health check and active cloud database status |

---

## 📂 Project Structure

```
final/
├── public/
│   └── index.html          # Web app frontend (exact UI preserved)
├── data/
│   ├── yatra.db            # Local fallback database
│   └── yatra.json          # Local backup snapshot
├── db.js                   # Unified Cloud Database driver (MongoDB / Postgres / SQLite)
├── server.js               # Express backend API & static server
├── package.json            # Dependencies (mongodb, pg, express, cors, compression, dotenv)
├── Dockerfile              # Container deployment
├── docker-compose.yml      # Docker compose configuration
├── render.yaml             # Render blueprint
├── .env.example            # Cloud database connection string templates
├── start.bat               # 1-click Windows launcher
└── README.md               # Documentation
```
