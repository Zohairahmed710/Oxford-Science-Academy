# 3D Rose Explorer & Science Buddy 🌹

A beautiful interactive 3D rose anatomy explorer with an AI Science Buddy chatbot — powered by **Groq AI (free)**, with a full offline fallback.

---

## 🚀 Quick Start

### Step 1 — Get a FREE Groq API Key (takes 1 minute)
1. Go to **https://console.groq.com**
2. Sign up (free, no credit card needed)
3. Click **"API Keys"** → **"Create API Key"**
4. Copy your key

### Step 2 — Paste key into config.json
Open `config.json` in Notepad and replace `YOUR_GROQ_API_KEY_HERE` with your key:
```json
{
  "groqApiKey": "gsk_xxxxxxxxxxxxxxxxxxxx"
}
```

### Step 3 — Start the server
Double-click **`start.bat`**

### Step 4 — Open in browser
Go to **http://localhost:3000**

---

## 📋 Requirements
- **Node.js** (v18+) — download free at https://nodejs.org
- **Internet connection** (for the 3D model viewer + AI chat)
- A free **Groq API key** (above)

---

## 💡 Features
| Feature | Description |
|---------|-------------|
| 🌹 3D Rose Viewer | Real photogrammetry model from Sketchfab |
| 🤖 AI Chatbot | Groq Llama-3 AI with rose anatomy expertise |
| 🔄 Varied Answers | Never gives the same answer twice |
| 📋 Generate Questions | 5, 10, or MCQ question sheets for teachers |
| 🎯 Interactive Quiz | 10-question scored quiz with instant feedback |
| 🖨️ Print Sheet | Print question sheets for students |
| 📴 Offline Fallback | Works without internet using built-in knowledge |

---

## 🛠 Changing the port
Edit `server.js` line 10: `const PORT = 3000;`

---

## 🔑 API Info
- **Provider**: [Groq](https://groq.com) — free tier
- **Model**: `llama-3.1-8b-instant` (fast + smart)
- **Free limit**: 6,000 tokens/minute (plenty for classroom use)
- **No credit card** required for free tier
