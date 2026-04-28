import admin from 'firebase-admin';

let messagingInstance: admin.messaging.Messaging | null = null;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (projectId && clientEmail && privateKey) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      } as admin.ServiceAccount),
    });
    messagingInstance = admin.messaging();
    console.log('🔔 Firebase Admin SDK initialized — push notifications enabled');
  } catch (error) {
    console.error('❌ Failed to initialize Firebase Admin SDK:', error);
  }
} else {
  console.warn('⚠️  Firebase credentials missing — push notifications disabled');
  console.warn('   Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in .env');
}

export const messaging = messagingInstance;
