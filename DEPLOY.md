# DPDzero Comp-Off Portal — Deploy Guide

## Step 1: Create a Gmail App Password

1. Go to your Google Account → **Security**
2. Enable **2-Step Verification** (if not already)
3. Search for **"App passwords"**
4. Create one for "Mail" → copy the 16-character password

---

## Step 2: Push to GitHub

1. Create a new repo at https://github.com/new (name it `compoff-portal`)
2. Run these commands in this folder:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/compoff-portal.git
git push -u origin main
```

---

## Step 3: Deploy on Render (Free)

1. Go to https://render.com and sign up (free)
2. Click **"New Web Service"**
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Add these **Environment Variables** in Render dashboard:

| Key | Value |
|-----|-------|
| `GMAIL_USER` | your_gmail@gmail.com |
| `GMAIL_PASS` | your 16-char app password |
| `BASE_URL` | https://your-app-name.onrender.com |

6. Click **Deploy** — done!

---

## How It Works

1. Employee opens the website URL
2. Selects name, weekend day(s) worked, comp-off date, and reason
3. Clicks **Submit** → email goes to **sandeep@dpdzero.com**
4. Sandeep sees **Approve / Reject** buttons in the email
5. If Approved → email automatically sent to HR:
   - jisna@dpdzero.com
   - varna@dpdzero.com
   - arun.kumar@dpdzero.com
