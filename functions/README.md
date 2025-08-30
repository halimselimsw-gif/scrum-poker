Cloud Function: removeParticipantOnLeft

This function listens for writes to `/rooms/{roomId}/participants/{uid}/leftAt` and removes the participant node. Deploy with the Firebase CLI from the `functions` folder.

Quick deploy:
1. Install Firebase CLI and login: `npm install -g firebase-tools` then `firebase login`.
2. From repo root run: `cd functions && npm install`.
3. Deploy: `firebase deploy --only functions:removeParticipantOnLeft`.

Notes:
- The function requires the project to be the same Firebase project used by the web app.
- If admin SDK lacks permissions, ensure the Functions runtime's service account has Realtime Database privileges.
