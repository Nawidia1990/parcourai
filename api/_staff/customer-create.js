// POST /api/staff-customer-create
// Creates a customer account with their contact information. The customer gets a random password they never
// see, and the staff member receives a one-time link to share so the customer sets their own.
// body: { email, name, phone, company, address, language, notes, tags, welcome?, plan?, unlimited?, analyses? }
import crypto from 'crypto';
import { requireStaff, admin, cleanStr, cleanTags, isEmail } from '../_staffauth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ctx = await requireStaff(req, res); if (!ctx) return;
  const b = req.body || {};
  const email = cleanStr(b.email, 200).toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  const name = cleanStr(b.name, 120);
  const crm = {
    phone: cleanStr(b.phone, 40), company: cleanStr(b.company, 120), address: cleanStr(b.address, 300),
    language: b.language === 'fr' ? 'fr' : 'en', notes: cleanStr(b.notes, 4000), tags: cleanTags(b.tags),
    source: 'staff', createdBy: ctx.user.uid, createdAt: new Date().toISOString()
  };
  try {
    const user = await admin.auth().createUser({ email, password: crypto.randomBytes(24).toString('base64'), displayName: name || undefined });
    const doc = { name, email, phone: crm.phone, location: crm.address, crm, createdAt: admin.firestore.FieldValue.serverTimestamp() };
    // Only admins can give a plan for free while creating the customer.
    const plan = b.plan;
    if (['essential', 'pro', 'premium'].includes(plan) && ctx.role === 'admin') {
      const n = Math.floor(Number(b.analyses));
      doc.grant = { plan, unlimited: b.unlimited === true, analyses: b.unlimited === true ? null : (Number.isFinite(n) && n >= 0 ? n : 0), grantedBy: ctx.user.uid, grantedAt: new Date().toISOString() };
    }
    await ctx.db.collection('users').doc(user.uid).set(doc, { merge: true });
    if (b.welcome) {
      await ctx.db.collection('users').doc(user.uid).collection('messages').add({
        subject: crm.language === 'fr' ? 'Bienvenue chez Parcourai' : 'Welcome to Parcourai',
        body: crm.language === 'fr' ? 'Votre compte est prêt. Définissez votre mot de passe avec le lien reçu, puis commencez par remplir votre profil dans « Parcours ». Écrivez-nous si vous avez des questions.'
          : 'Your account is ready. Set your password with the link you received, then start by filling in your profile under Background. Write to us if you have any questions.',
        fromUid: ctx.user.uid, fromName: 'Parcourai Support', createdAt: admin.firestore.FieldValue.serverTimestamp(), read: false
      });
    }
    const setupLink = await admin.auth().generatePasswordResetLink(email);
    return res.status(200).json({ uid: user.uid, email, setupLink, granted: !!doc.grant });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') return res.status(409).json({ error: 'An account with that email already exists. Use "Open customer" to find it.' });
    return res.status(500).json({ error: e.message });
  }
}
