// Vercel serverless function: single entry point for all staff/admin endpoints.
// The Hobby plan allows at most 12 functions per deployment, so the seven staff
// handlers live in api/_staff/ (underscore folders are not deployed as functions)
// and vercel.json rewrites /api/staff-<name> to /api/staff?a=<name>.
import list from './_staff/list.js';
import createUser from './_staff/create-user.js';
import dashboardStats from './_staff/dashboard-stats.js';
import errorLogs from './_staff/error-logs.js';
import exportUsers from './_staff/export-users.js';
import userAction from './_staff/user-action.js';
import userLookup from './_staff/user-lookup.js';
import customers from './_staff/customers.js';
import customer from './_staff/customer.js';
import subscriptionAction from './_staff/subscription-action.js';
import refund from './_staff/refund.js';
import message from './_staff/message.js';
import bootstrap from './_staff/bootstrap.js';
import customerCreate from './_staff/customer-create.js';
import customerSave from './_staff/customer-save.js';
import users from './_staff/users.js';
import hr from './_staff/hr.js';

const ROUTES = {
  'list': list,
  'create-user': createUser,
  'dashboard-stats': dashboardStats,
  'error-logs': errorLogs,
  'export-users': exportUsers,
  'user-action': userAction,
  'user-lookup': userLookup,
  'customers': customers,
  'customer': customer,
  'subscription-action': subscriptionAction,
  'refund': refund,
  'message': message,
  'bootstrap': bootstrap,
  'customer-create': customerCreate,
  'customer-save': customerSave,
  'users': users,
  'hr-list': hr,
  'hr-save': hr,
  'hr-delete': hr,
  'hr-account': hr,
  'hr-task-save': hr,
  'hr-task-delete': hr,
};

export default async function handler(req, res) {
  const a = String((req.query && req.query.a) || '');
  const fn = ROUTES[a];
  if (!fn) return res.status(404).json({ error: 'Unknown staff endpoint' });
  return fn(req, res);
}
