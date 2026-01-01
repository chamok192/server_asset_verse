const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const jwtSecret = process.env.JWT_SECRET || 'your_default_secret_here';

class AuthController {
    constructor(collections) {
        this.userCollection = collections.userCollection;
        this.employeeAffiliationCollection = collections.employeeAffiliationCollection;
    }

    async login(req, res) {
        try {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

            const user = await this.userCollection.findOne({ email });
            if (!user) return res.status(404).json({ error: 'User not found' });

            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) return res.status(401).json({ error: 'Invalid password' });

            const token = jwt.sign({ email: user.email, role: user.role }, jwtSecret, { expiresIn: '24h' });
            res.json({ token, user });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getProfile(req, res) {
        try {
            const email = req.user.email;
            const user = await this.userCollection.findOne({ email });
            if (!user) return res.status(404).json({ error: 'User not found' });

            // For employees, include affiliation data
            if (user.role === 'employee') {
                const affiliations = await this.employeeAffiliationCollection.find({
                    employeeEmail: { $regex: new RegExp(`^${email}$`, 'i') },
                    status: 'active'
                }).toArray();

                // Get HR details for each affiliation
                const affiliationsWithHR = [];
                for (const aff of affiliations) {
                    const hr = await this.userCollection.findOne(
                        { email: aff.hrEmail },
                        { projection: { name: 1, email: 1, companyName: 1, profileImage: 1, companyLogo: 1 } }
                    );
                    if (hr) {
                        affiliationsWithHR.push({
                            ...aff,
                            hr: {
                                name: hr.name,
                                email: hr.email,
                                companyName: hr.companyName,
                                profileImage: hr.profileImage,
                                companyLogo: hr.companyLogo
                            }
                        });
                    }
                }

                user.affiliations = affiliationsWithHR;
            }

            res.json(user);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async updateProfile(req, res) {
        try {
            const email = req.user.email;
            const updateData = req.body;
            delete updateData.email;
            delete updateData.password;
            delete updateData.role;
            delete updateData._id;

            const result = await this.userCollection.updateOne({ email }, { $set: updateData });
            if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found' });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async register(req, res) {
        try {
            const { name, email, password, ...other } = req.body;
            if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });

            const existing = await this.userCollection.findOne({ email });
            if (existing) return res.status(400).json({ error: 'User already exists' });

            const hashedPassword = await bcrypt.hash(password, 10);
            const user = { name, email, password: hashedPassword, ...other, createdAt: new Date() };
            await this.userCollection.insertOne(user);
            res.json({ success: true, user: { ...user, password: undefined } });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async checkEmail(req, res) {
        try {
            const email = req.params.email;
            const user = await this.userCollection.findOne({ email });
            res.json({ exists: !!user });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getUserByEmail(req, res) {
        try {
            const email = req.params.email;
            const user = await this.userCollection.findOne({ email });
            if (!user) return res.status(404).json({ error: 'User not found' });

            if (user.role && String(user.role).toLowerCase() === 'hr') {
                const actualCount = await this.employeeAffiliationCollection.countDocuments({ hrEmail: email, status: 'active' });
                if (user.currentEmployees !== actualCount) {
                    await this.userCollection.updateOne({ email }, { $set: { currentEmployees: actualCount } });
                    user.currentEmployees = actualCount;
                }
            }

            // For employees, include affiliation data
            if (user.role && String(user.role).toLowerCase() === 'employee') {
                const affiliations = await this.employeeAffiliationCollection.find({
                    employeeEmail: { $regex: new RegExp(`^${email}$`, 'i') },
                    status: 'active'
                }).toArray();

                // Get HR details for each affiliation
                const affiliationsWithHR = [];
                for (const aff of affiliations) {
                    const hr = await this.userCollection.findOne(
                        { email: aff.hrEmail },
                        { projection: { name: 1, email: 1, companyName: 1, profileImage: 1, companyLogo: 1 } }
                    );
                    if (hr) {
                        affiliationsWithHR.push({
                            ...aff,
                            hr: {
                                name: hr.name,
                                email: hr.email,
                                companyName: hr.companyName,
                                profileImage: hr.profileImage,
                                companyLogo: hr.companyLogo
                            }
                        });
                    }
                }

                user.affiliations = affiliationsWithHR;
            }

            const { password, ...safeUser } = user;
            res.json(safeUser);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async checkLimit(req, res) {
        try {
            const email = req.user.email;
            const user = await this.userCollection.findOne({ email });
            if (!user || String(user.role).toLowerCase() !== 'hr') {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const limit = user.packageLimit || 0;
            const current = await this.employeeAffiliationCollection.countDocuments({ hrEmail: email, status: 'active' });
            res.json({ canAdd: current < limit, current, limit });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async updateRole(req, res) {
        try {
            const id = req.params.id;
            const roleInfo = req.body;
            const result = await this.userCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role: roleInfo.role } });
            res.send(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = AuthController;