function buildUserDocument(userData) {
  const now = new Date();
  
  const baseUser = {
    name: userData.name || '',
    email: userData.email,
    uid: userData.uid,
    role: userData.role || 'Employee',
    dateOfBirth: userData.dateOfBirth || null,
    profileImage: userData.profileImage || '',
    phone: userData.phone || '',
    address: userData.address || '',
    createdAt: userData.createdAt || now,
    updatedAt: now
  };

  if (userData.role === 'HR' || userData.role === 'Admin') {
    baseUser.companyName = userData.companyName || '';
    baseUser.companyLogo = userData.companyLogo || '';
    baseUser.packageLimit = userData.packageLimit || 5; // Default 5 employees
    baseUser.currentEmployees = userData.currentEmployees || 0;
    baseUser.subscription = userData.subscription || null; // No package assigned by default
    baseUser.subscriptionDate = userData.subscriptionDate || null;
  } else if (userData.role === 'Employee') {
    baseUser.companies = userData.companies || []; // Array of {companyName, hrEmail, joinedAt}
  }

  return baseUser;
}

function validateUser(userData) {
  const errors = [];

  if (!userData.email) errors.push('Email is required');
  if (!userData.uid) errors.push('UID is required');

  const validRoles = ['Employee', 'HR', 'Admin'];
  if (userData.role && !validRoles.includes(userData.role)) {
    errors.push(`Role must be one of: ${validRoles.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { buildUserDocument, validateUser };
