const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

// Cloud Function: when a participant gets a leftAt timestamp set, remove the node
// This runs with admin privileges so it can delete nodes even if client rules block deletes.
exports.removeParticipantOnLeft = functions.database
  .ref('/rooms/{roomId}/participants/{uid}/leftAt')
  .onWrite(async (change, context) => {
    const { roomId, uid } = context.params;
    const leftAt = change.after.val();

    // only act on initial set (non-null) and when value is truthy
    if (!leftAt) return null;

    const participantRef = db.ref(`/rooms/${roomId}/participants/${uid}`);
    try {
      await participantRef.remove();
      console.log(`Removed participant ${uid} from room ${roomId} after leftAt=${leftAt}`);
    } catch (e) {
      console.error('removeParticipantOnLeft failed for', roomId, uid, e);
      // As a fallback, write a tombstone under /rooms/<roomId>/removedParticipants/<uid>
      try {
        await db.ref(`/rooms/${roomId}/removedParticipants/${uid}`).set({ removedAt: Date.now(), leftAt });
      } catch (ee) {
        console.error('Failed to write tombstone for', roomId, uid, ee);
      }
    }
    return null;
  });
