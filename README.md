# Campus Hub

**Your campus, connected.** Campus Hub is a campus community platform for students and teachers, with a polished desktop interface and an Electron app for Windows.

**Stack:** React + Vite · Node.js + Express · SQLite (`better-sqlite3`) · Electron · optional AWS S3 uploads.

## What it includes

- Student and teacher accounts, with admin verification and role controls.
- Course, department, club, and campus-wide communities.
- Posts for discussions, questions, resources, and announcements.
- Threaded comments, voting, notifications, search, moderation, and admin tools.
- Reddit-style media: image/video previews in the feed, galleries, lightbox, drag-and-drop and paste uploads; private AWS S3 storage (or local disk).
- A Windows desktop shell with local SQLite data stored in the user's application-data directory.

## Install dependencies

Use Node.js 22 LTS or newer supported by the installed packages. From the project root:

```powershell
npm run install:all
```

The Electron app uses the Electron Node runtime for its local API, so rebuild the native SQLite module for Electron before launching or packaging.

## Run Campus Hub as a desktop app

```powershell
npm run electron:dev
```

This builds the React UI, rebuilds `better-sqlite3` for Electron, starts the local API inside the Electron runtime, and opens the desktop window.

## Build a Windows installer

Run on Windows:

```powershell
npm run electron:pack
```

The installer will be created in `release/` as `Campus-Hub-Setup-1.0.0.exe`. The NSIS installer creates Start Menu and desktop shortcuts and lets the user choose the install directory.

To produce an unpacked test build instead:

```powershell
npm run electron:dir
```

## Run the web app during development

```powershell
npm run dev:server
```

In a second terminal:

```powershell
npm run dev:client
```

Then open `http://localhost:5173`. If you are using the desktop app, use `npm run electron:dev` instead.

## Local data and configuration

The desktop app stores its SQLite database and uploads under the operating system's application-data directory for Campus Hub. The server can also be configured with `server/.env`; see `.env.example` for supported settings. Without `S3_BUCKET`, uploaded files are stored locally.

### Load demo accounts and sample activity

Start the server once (or stop it if it is already running), then from the project root run:

```powershell
npm run seed:demo
```

This adds fictional users, campus communities, sample posts, and comments. It is safe to rerun for the demo database and will not duplicate the seeded posts/comments. All demo accounts use the password `password123` (the login page has one-click fill buttons).

| Role | Username | Email |
|---|---|---|
| Admin | `admin` | `admin@college.edu` |
| Teacher | `prof_rao` | `prof.rao@college.edu` |
| Teacher | `prof_sharma` | `prof.sharma@college.edu` |
| Student | `asha` | `asha@college.edu` |
| Student | `ravi` | `ravi@college.edu` |
| Student | `meera` | `meera@college.edu` |
| Student | `arjun` | `arjun@college.edu` |
| Student | `nisha` | `nisha@college.edu` |
| Student | `faiz` | `faiz@college.edu` |
| Student | `divya` | `divya@college.edu` |

These are fictional accounts for local classroom demonstrations only. Never seed demo accounts in a production environment.

## Cloud storage (AWS S3)

Uploads (images, video, PDFs, documents) go to a **private S3 bucket** when `S3_BUCKET` is set in `.env`; otherwise they stay on local disk. The API streams files to the browser, so the bucket never needs to be public.

One-time setup on Windows (needs the AWS CLI and `aws configure` with your own AWS account):

```powershell
winget install Amazon.AWSCLI
aws configure
powershell -ExecutionPolicy Bypass -File infra\setup-aws.ps1 -Bucket my-college-campus-hub-demo -Region ap-south-1
```

This creates the bucket (private + encrypted), a least-privilege IAM user, and writes `S3_BUCKET`, `AWS_REGION` and the access keys into `.env`. Linux/macOS: `infra/setup-aws.sh <bucket> <region>`, then fill the keys in `.env` (or attach an IAM role on EC2).

Restart the server and open `http://localhost:4000/api/health` - you should see `"storage":"s3"` and `"check":{"ok":true}`. The server log also prints `[storage] OK - s3: s3://<bucket>/uploads/`.

The SQLite database stays local (`DB_PATH`). For a demo that is fine; keep it on a persistent volume if you deploy it.

## Demo-mode security

This build is for a classroom demo: **login only**. Passwords are stored in plain text, there is no rate limiting, and any email can register. Do not use it with real data.
