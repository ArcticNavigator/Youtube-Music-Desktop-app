# Tunecat Music

_Last updated: 2026-06-17 · Policy version: **1**_

This is a personal app shared privately with a small group (≤100 people). It is **not**
a public product. This policy explains exactly what is collected, why, and your rights.

## What we collect and only this

When you **sign in with Google**, one record is created on our server (Supabase):

| Field                                   | Why (lawful basis)                                                     |
| --------------------------------------- | ---------------------------------------------------------------------- |
| **Name**                                | identifies your account · GDPR Art. 6(1)(b) contract necessity         |
| **Email**                               | identifies your account · Art. 6(1)(b)                                 |
| **First sign-in time** (UTC)            | account/security history · Art. 6(1)(b)                                |
| **Approximate city / region / country** | sign-in-location & security context · Art. 6(1)(f) legitimate interest |
| Policy version + last-active timestamp  | operate the account, apply retention                                   |

We do **not** store your IP address, precise location, listening history, playlists,
or any Google content on our server. Your playlists/liked-songs live in your Google
account and are read live via Google's API; your **play history is stored only on your
own computer** (`%APPDATA%/YouTubeMusic/history.json`), never uploaded.

If you use **Connect YouTube Music** for full personalization, your YouTube Music
**session is stored only on your own device** (in your app-data folder) and is sent
**only to YouTube** and the app's local helper to load your personalized content. It
is **never** sent to our server. Disconnecting deletes it from your device.

## Guest mode = no record

If you don't sign in, **nothing** is stored about you. Search, browse and playback work
fully in guest mode. Signing in is a free, genuine choice (GDPR Art. 7(4)).

## How location is derived (privacy-preserving)

Your **approximate** city is resolved **on your device**: the app learns its own public
IP from our server, then looks the IP up against a **local** DB-IP database bundled with
the app. Your IP is **never** sent to a third-party geolocation service.

## What we never do

- Never sell your data. Never use your email for marketing or ads (Google API Limited Use).
- Never share it with third parties.

## Your rights

From **Settings** inside the app:

- **Export my data** - see the exact record we hold (JSON).
- **Delete my data** - permanently erase the record, revoke the app's Google access, and
  return to guest mode. No retention.

You may also email the contact below to access, correct, or erase your data, or to object
to the location field. (Rights under GDPR/UK-GDPR, India DPDP Act 2023, and CCPA/CPRA.)

## Retention

We keep the record only while your account is active. **Inactive accounts are
automatically and permanently erased after 6 months.** When that happens we keep only an
**anonymous** counter (country + date, no name/email) so we can see how many accounts
lapsed, never an identifiable list of departed users.

## Security

TLS in transit; Postgres disk encryption at rest; row-level security so no user can read
another's record; all privileged access brokered by server-side Edge Functions (the app
never holds the database admin key). Your Google refresh token is stored only in your
operating system's keychain, never on our server.

## Grievance / contact

**Arctic Navigator** - cypher.jscript@gmail.com
(Data Principal grievance contact under India's DPDP Act 2023.)

## Attribution

IP-to-city data: **DB-IP.com / IP to City Lite** database, licensed under
**CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/).
