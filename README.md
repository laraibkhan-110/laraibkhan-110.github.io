# Laraib Portfolio (frontend + backend)

Dark portfolio website with a password-protected admin dashboard.
The backend is one file (`server.js`) with **no npm packages**. You only need Node.js 18 or newer.

## Roman Urdu mein khulasa
1. Node.js install karein (nodejs.org).
2. Folder mein terminal kholein aur chalayen: `node server.js`
3. Browser mein `http://localhost:3000` kholein.
4. Dashboard kholne ke liye page par click karke **Ctrl + Alt + D** dabayen (phone par footer ke "© 2026 The Laraib" par 3 baar tap).
   Pehli baar password banane ko kahega (kam az kam 8 akshar). Uske baad wohi password poochega.
5. Dashboard mein Skills, Certificates (image aur verify link ke saath), Connections (LinkedIn wagera) aur About badal sakte hain.
   Jo badlein wo **sab visitors ko dikhta hai**, sirf aap ko nahi.

## Folder structure
```
laraib-portfolio/
  server.js              backend: static files + JSON API + login + image upload
  default-content.json   starting content (used until you save changes)
  package.json
  Dockerfile             optional, for Docker hosting
  .env.example           optional settings
  public/                the website (what visitors download)
    index.html
    css/style.css
    js/app.js            page animations + dashboard (talks to the API)
    img/hero.webp        hero character image
  data/                  created and filled by the backend (back this folder up!)
    content.json         skills, certificates, links, about text
    auth.json            password hash + session secret  (keep private)
    uploads/             images you upload in the dashboard
```

## API
| Method | Path | Who | What |
|---|---|---|---|
| GET | /api/content | everyone | skills, certs, links, about |
| GET | /api/me | everyone | `{admin, setup}` |
| POST | /api/setup | first run only | create the admin password |
| POST | /api/login | everyone (rate limited) | `{password}` -> session cookie |
| POST | /api/logout | everyone | end session |
| POST | /api/password | admin | change password (logs out other sessions) |
| PUT | /api/content | admin | save all content |
| POST | /api/upload | admin | `{data: "data:image/jpeg;base64,..."}` -> `{id, url}` |
| DELETE | /api/upload/:id | admin | delete an uploaded image |

## Settings (environment variables)
See `.env.example`: `PORT`, `ADMIN_PASSWORD`, `COOKIE_SECURE`, `DATA_DIR`.

## Deploying
You need a host that can run Node.js (Render, Railway, Fly.io, a VPS, or Docker).
Static-only hosts (GitHub Pages, plain Netlify) cannot run the backend, so the dashboard would not work there.
Important: keep `data/` on a **persistent disk/volume**. Many free hosts wipe the disk on every deploy, which would delete your content and uploads.
Serve the site over HTTPS (most hosts do this for you).

## Security notes
- Password is stored as a scrypt hash. Sessions are signed, HttpOnly, SameSite=Strict cookies that last 8 hours.
- Login is limited to 5 wrong attempts per 10 minutes per IP.
- All saved content is validated and trimmed on the server; uploads are checked to be real JPEG/PNG/WebP files (max 1.5 MB).
- The dashboard also logs you out when you close it.
- Forgot the password? Stop the server, delete `data/auth.json`, start again and create a new one.

## Known limits
- Projects and the "View project" detail pages are still sample text inside `public/js/app.js` (search for `var PD=`). Edit them there.
- Content is kept in JSON files, which is fine for one person. For many editors or heavy traffic, move to a real database.
