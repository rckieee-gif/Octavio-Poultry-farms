const roleAliases = {
  Admin: 'AdminOwner',
  OpManager: 'OperationManager',
  admin: 'AdminOwner',
  adminowner: 'AdminOwner',
  dataentry: 'DataEntry',
  operationmanager: 'OperationManager',
  opmanager: 'OperationManager',
  viewer: 'Viewer',
};

const roleRank = {
  Viewer: 1,
  DataEntry: 2,
  OperationManager: 3,
  AdminOwner: 4,
};

function normalizeRole(role) {
  if (!role) return role;
  const compactRole = String(role).replace(/[\s_-]/g, '').toLowerCase();
  return roleAliases[role] || roleAliases[compactRole] || role;
}

function hasMinimumRole(userRole, minimumRole) {
  return (roleRank[normalizeRole(userRole)] || 0) >= (roleRank[minimumRole] || 0);
}

function requireMinimumRole(minimumRole) {
  return (req, res, next) => {
    if (!hasMinimumRole(req.user.role, minimumRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = {
  normalizeRole,
  hasMinimumRole,
  requireMinimumRole,
};
