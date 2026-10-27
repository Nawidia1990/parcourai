// POST /api/staff-message  { uid, subject, body, alsoEmail? }
// Sends an in-app message that appears in the customer's Account space. If RESEND_API_KEY and
// RESEND_FROM are set, it can also be sent by email.
import { requireStaff, admin } from '../_staffauth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ctx = await requireStaff(req, res); if (!ctx) return;
  const { uid, subject, body, alsoEmail } = req.body || {};
  const sub = String(subject || '').trim().slice(0, 160);
  const text = String(body || '').trim().slice(0, 5000);
  if (!uid || !sub || !text) return res.status(400).json({ error: 'Choose a customer and write a subject and a message.' });
  try {
    const target = await admin.auth().getUser(uid);
    const me = await admin.auth().getUser(ctx.user.uid);
    await ctx.db.collection('users').doc(uid).collection('messages').add({
      subject: sub, body: text, fromUid: ctx.user.uid, fromName: 'Parcourai Support', fromEmail: me.email || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), read: false
    });
    let emailed = null; let note = '';
    if (alsoEmail) {
      if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: process.env.RESEND_FROM, to: [target.email], subject: sub, text, reply_to: me.email || undefined })
        });
        emailed = r.ok;
        if (!r.ok) note = ' The email could not be sent (' + r.status + ').';
      } else {
        note = ' Email sending is not set up (add RESEND_API_KEY and RESEND_FROM in Vercel), so only the in-app message was sent.';
      }
    }
    return res.status(200).json({ message: 'Message sent to ' + target.email + '.' + (emailed ? ' Email sent too.' : '') + note });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
