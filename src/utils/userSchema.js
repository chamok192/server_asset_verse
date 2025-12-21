function buildUserDocument(userData) {
    const now = new Date();
    const role = userData.role || 'Employee';

    const baseUser = {
        uid: userData.uid,
        email: userData.email,
        name: userData.name,
        profileImage: userData.profileImage || '',
        dateOfBirth: userData.dateOfBirth || '',
        role: role,
        createdAt: userData.createdAt || now,
        updatedAt: now
    };

    if (role === 'HR') {
        const subscription = userData.subscription || 'free';
        const packageLimit = subscription === 'free' ? 3 : (Number(userData.packageLimit) || 3);

        return {
            ...baseUser,
            companyName: userData.companyName || '',
            companyLogo: userData.companyLogo || '',
            packageLimit: packageLimit,
            currentEmployees: Number(userData.currentEmployees) || 0,
            subscription: subscription,
            subscriptionDate: userData.subscriptionDate || now
        };
    }

    return baseUser;
}

function validateUser(userData) {
    const errors = [];
    if (!userData.email) errors.push('Email is required');
    if (!userData.name) errors.push('Name is required');
    if (!userData.role) errors.push('Role is required');
    if (!userData.uid) errors.push('UID is required');

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    buildUserDocument,
    validateUser
};
