// Human-resources endpoints (ADMIN ONLY), all through /api/staff-<op>:
//   hr-list         GET   employees (with login status) and HR tasks
//   hr-save         POST  { employee }  create or update an employee record
//   hr-delete       POST  { id }
//   hr-account      POST  { id, action: 'create' | 'disable' | 'enable' | 'setRole' | 'reset', role? }
//   hr-task-save    POST  { task }
//   hr-task-delete  POST  { id }
// Records live in the hr_employees and hr_tasks collections, which only the server reads and writes.
import crypto from 'crypto';
import { requireStaff, admin, cleanStr, isEmail } from '../_staffauth.js';

const TYPES = ['full-time', 'part-time', 'contract', 'intern'];
const STATUSES = ['onboarding', 'active', 'onleave', 'terminated'];
const LEAVE_TYPES = ['vacation', 'sick', 'personal', 'unpaid', 'other'];
const LEAVE_STATUS = ['pending', 'approved', 'rejected'];
const newId = () => crypto.randomBytes(6).toString('hex');
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');

function cleanEmployee(e) {
  const out = {
    firstName: cleanStr(e.firstName, 80), lastName: cleanStr(e.lastName, 80), workEmail: cleanStr(e.workEmail, 200).toLowerCase(), personalEmail: cleanStr(e.personalEmail, 200),
    phone: cleanStr(e.phone, 40), address: cleanStr(e.address, 300), title: cleanStr(e.title, 120), department: cleanStr(e.department, 120), manager: cleanStr(e.manager, 120),
    employmentType: TYPES.includes(e.employmentType) ? e.employmentType : 'full-time', status: STATUSES.includes(e.status) ? e.status : 'onboarding',
    workLocation: cleanStr(e.workLocation, 120), startDate: day(e.startDate), endDate: day(e.endDate),
    emergencyName: cleanStr(e.emergencyName, 120), emergencyPhone: cleanStr(e.emergencyPhone, 40), emergencyRelation: cleanStr(e.emergencyRelation, 60),
    salary: cleanStr(e.salary, 40), payFrequency: cleanStr(e.payFrequency, 40), about: cleanStr(e.about, 4000),
    leaveAllowance: Math.max(0, Math.min(365, Number(e.leaveAllowance) || 0))
  };
  out.checklist = (Array.isArray(e.checklist) ? e.checklist : []).slice(0, 60).map((c) => ({ id: cleanStr(c.id, 20) || newId(), label: cleanStr(c.label, 160), group: c.group === 'offboarding' ? 'offboarding' : 'onboarding', done: c.done === true })).filter((c) => c.label);
  out.leave = (Array.isArray(e.leave) ? e.leave : []).slice(0, 200).map((l) => ({ id: cleanStr(l.id, 20) || newId(), type: LEAVE_TYPES.includes(l.type) ? l.type : 'vacation', from: day(l.from), to: day(l.to), days: Math.max(0, Math.min(365, Number(l.days) || 0)), status: LEAVE_STATUS.includes(l.status) ? l.status : 'pending', note: cleanStr(l.note, 300) })).filter((l) => l.from);
  out.notes = (Array.isArray(e.notes) ? e.notes : []).slice(0, 200).map((n) => ({ id: cleanStr(n.id, 20) || newId(), date: day(n.date), text: cleanStr(n.text, 2000), author: cleanStr(n.author, 120) })).filter((n) => n.text);
  return out;
}
function cleanTask(t) {
  return {
    title: cleanStr(t.title, 200), assigneeId: cleanStr(t.assigneeId, 40), due: day(t.due), category: cleanStr(t.category, 60),
    priority: ['low', 'normal', 'high'].includes(t.priority) ? t.priority : 'normal', status: t.status === 'done' ? 'done' : 'open', notes: cleanStr(t.notes, 1000)
  };
}

export default async function handler(req, res) {
  const ctx = await requireStaff(req, res, { adminOnly: true }); if (!ctx) return;
  const { db } = ctx;
  const op = String(req.query.a || '');
  const now = new Date().toISOString();
  try {
    if (op === 'hr-list') {
      const [emps, tasks] = await Promise.all([db.collection('hr_employees').get(), db.collection('hr_tasks').get()]);
      const employees = await Promise.all(emps.docs.map(async (d) => {
        const e = { id: d.id, ...d.data() };
        if (e.uid) {
          try {
            const [u, p] = await Promise.all([admin.auth().getUser(e.uid), db.collection('users').doc(e.uid).get()]);
            e.account = { email: u.email, disabled: u.disabled, role: p.exists ? (p.data().role || null) : null, lastSignInAt: u.metadata.lastSignInTime || null };
          } catch (err) { e.account = null; }
        }
        return e;
      }));
      employees.sort((a, b) => (a.lastName || '').localeCompare(b.lastName || '') || (a.firstName || '').localeCompare(b.firstName || ''));
      return res.status(200).json({ employees, tasks: tasks.docs.map((d) => ({ id: d.id, ...d.data() })) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = req.body || {};

    if (op === 'hr-save') {
      const e = b.employee || {};
      const data = cleanEmployee(e);
      if (!data.firstName && !data.lastName) return res.status(400).json({ error: 'Enter at least a first or last name.' });
      if (data.workEmail && !isEmail(data.workEmail)) return res.status(400).json({ error: 'The work email is not valid.' });
      data.updatedAt = now;
      let id = cleanStr(e.id, 40);
      if (id && (await db.collection('hr_employees').doc(id).get()).exists) {
        await db.collection('hr_employees').doc(id).set(data, { merge: true });
      } else {
        data.createdAt = now;
        const ref = await db.collection('hr_employees').add(data); id = ref.id;
      }
      return res.status(200).json({ message: 'Employee saved.', id });
    }
    if (op === 'hr-delete') {
      if (!b.id) return res.status(400).json({ error: 'id is required.' });
      await db.collection('hr_employees').doc(String(b.id)).delete();
      return res.status(200).json({ message: 'Employee record deleted. Their login, if any, was not touched.' });
    }
    if (op === 'hr-account') {
      const ref = db.collection('hr_employees').doc(String(b.id || ''));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Employee not found.' });
      const emp = snap.data();
      const action = b.action;
      const role = b.role === 'admin' ? 'admin' : 'staff';
      if (action === 'create') {
        if (!isEmail(emp.workEmail)) return res.status(400).json({ error: 'Save a valid work email on the employee first.' });
        let uid; let linked = false;
        try {
          uid = (await admin.auth().createUser({ email: emp.workEmail, password: crypto.randomBytes(24).toString('base64'), displayName: `${emp.firstName} ${emp.lastName}`.trim() || undefined })).uid;
        } catch (err) {
          if (err.code !== 'auth/email-already-exists') throw err;
          uid = (await admin.auth().getUserByEmail(emp.workEmail)).uid; linked = true;
        }
        await db.collection('users').doc(uid).set({ role, createdByAdmin: ctx.user.uid }, { merge: true });
        await ref.set({ uid, updatedAt: now }, { merge: true });
        const setupLink = linked ? null : await admin.auth().generatePasswordResetLink(emp.workEmail);
        return res.status(200).json({ message: linked ? 'That email already had an account: it is now linked to this employee with the ' + role + ' role.' : 'Login created.', setupLink, uid });
      }
      if (!emp.uid) return res.status(400).json({ error: 'This employee has no login yet.' });
      if (emp.uid === ctx.user.uid && ['disable', 'setRole'].includes(action)) return res.status(400).json({ error: 'You cannot change your own access here.' });
      if (action === 'disable' || action === 'enable') {
        await admin.auth().updateUser(emp.uid, { disabled: action === 'disable' });
        return res.status(200).json({ message: action === 'disable' ? 'Login disabled.' : 'Login enabled.' });
      }
      if (action === 'setRole') {
        if (b.role === 'none') await db.collection('users').doc(emp.uid).set({ role: admin.firestore.FieldValue.delete() }, { merge: true });
        else await db.collection('users').doc(emp.uid).set({ role }, { merge: true });
        return res.status(200).json({ message: b.role === 'none' ? 'Staff access removed.' : 'Role set to ' + role + '.' });
      }
      if (action === 'reset') {
        const u = await admin.auth().getUser(emp.uid);
        return res.status(200).json({ message: 'Reset link generated for ' + u.email + '.', setupLink: await admin.auth().generatePasswordResetLink(u.email) });
      }
      return res.status(400).json({ error: 'Unknown action.' });
    }
    if (op === 'hr-task-save') {
      const t = b.task || {};
      const data = cleanTask(t);
      if (!data.title) return res.status(400).json({ error: 'Give the task a title.' });
      data.updatedAt = now;
      const id = cleanStr(t.id, 40);
      if (id && (await db.collection('hr_tasks').doc(id).get()).exists) await db.collection('hr_tasks').doc(id).set(data, { merge: true });
      else { data.createdAt = now; await db.collection('hr_tasks').add(data); }
      return res.status(200).json({ message: 'Task saved.' });
    }
    if (op === 'hr-task-delete') {
      if (!b.id) return res.status(400).json({ error: 'id is required.' });
      await db.collection('hr_tasks').doc(String(b.id)).delete();
      return res.status(200).json({ message: 'Task deleted.' });
    }
    return res.status(404).json({ error: 'Unknown HR endpoint.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
