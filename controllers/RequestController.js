const { ObjectId } = require('mongodb');

class RequestController {
    constructor(collections) {
        this.requestCollection = collections.requestCollection;
        this.assetCollection = collections.assetCollection;
        this.userCollection = collections.userCollection;
        this.assignedAssetCollection = collections.assignedAssetCollection;
        this.employeeAffiliationCollection = collections.employeeAffiliationCollection;
    }

    async getRequests(req, res) {
        try {
            if (req.user.role !== 'hr' && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const hrEmail = req.user.email;
            const hrRequests = await this.requestCollection.find({
                hrEmail: { $regex: new RegExp(`^${hrEmail}$`, 'i') },
                status: 'pending'
            }).toArray();

            const populatedRequests = [];
            for (const requestDoc of hrRequests) {
                const employee = await this.userCollection.findOne({ email: requestDoc.employeeEmail }, { projection: { name: 1, email: 1 } });
                let asset = null;
                try { asset = await this.assetCollection.findOne({ _id: new ObjectId(requestDoc.assetId) }); } catch (e) { }

                populatedRequests.push({
                    ...requestDoc,
                    employee: employee ? { name: employee.name, email: employee.email } : { name: 'Unknown', email: requestDoc.employeeEmail },
                    asset: asset ? { productName: asset.productName || asset.name, availableQuantity: asset.availableQuantity ?? asset.quantity } : { productName: 'Unknown Asset' }
                });
            }

            res.json({ success: true, data: populatedRequests });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async approveRequest(req, res) {
        try {
            if (req.user.role !== 'hr' && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const id = req.params.id;
            const request = await this.requestCollection.findOne({ _id: new ObjectId(id) });

            if (!request) return res.status(404).json({ error: 'Request not found' });
            if (request.hrEmail.toLowerCase() !== req.user.email.toLowerCase()) return res.status(403).json({ error: 'Forbidden' });

            const asset = await this.assetCollection.findOne({ _id: new ObjectId(request.assetId) });
            if (!asset || (asset.availableQuantity ?? asset.quantity) <= 0) {
                return res.status(400).json({ error: 'Asset out of stock' });
            }

            // Decrement available quantity only
            const currentAvailable = asset.availableQuantity ?? asset.quantity ?? 0;
            await this.assetCollection.updateOne(
                { _id: new ObjectId(request.assetId) },
                { $set: { availableQuantity: currentAvailable - 1 } }
            );

            // Add to assigned assets
            const employee = await this.userCollection.findOne({ email: request.employeeEmail });
            const hr = await this.userCollection.findOne({ email: request.hrEmail });

            await this.assignedAssetCollection.insertOne({
                assetId: new ObjectId(request.assetId),
                assetName: asset.productName || asset.name,
                assetType: asset.productType || asset.type,
                employeeEmail: request.employeeEmail,
                employeeName: employee?.name || 'Unknown',
                hrEmail: request.hrEmail,
                companyName: hr?.companyName || `${hr?.name || 'HR'}'s Company`,
                assignmentDate: new Date(),
                status: 'assigned'
            });

            // Ensure affiliation
            const existingAffiliation = await this.employeeAffiliationCollection.findOne({
                employeeEmail: request.employeeEmail,
                hrEmail: request.hrEmail
            });
            const isNewAffiliation = !existingAffiliation;
            console.log(`Existing affiliation: ${!!existingAffiliation}, isNew: ${isNewAffiliation}`);

            await this.employeeAffiliationCollection.updateOne(
                { employeeEmail: request.employeeEmail, hrEmail: request.hrEmail },
                {
                    $set: {
                        employeeName: employee?.name || 'Unknown',
                        companyName: hr?.companyName || `${hr?.name || 'HR'}'s Company`,
                        status: 'active',
                        lastUpdate: new Date()
                    },
                    $setOnInsert: {
                        joinedAt: new Date()
                    }
                },
                { upsert: true }
            );

            // Increment HR's currentEmployees if new affiliation
            if (isNewAffiliation) {
                await this.userCollection.updateOne(
                    { email: request.hrEmail },
                    { $inc: { currentEmployees: 1 } }
                );
                console.log(`Incremented currentEmployees for HR ${request.hrEmail}`);
            }

            await this.requestCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: 'approved', processedBy: req.user.email, processedAt: new Date() } });
            console.log(`Request ${id} approved successfully`);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async rejectRequest(req, res) {
        try {
            if (req.user.role !== 'hr' && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const id = req.params.id;
            const request = await this.requestCollection.findOne({ _id: new ObjectId(id) });

            if (!request) return res.status(404).json({ error: 'Request not found' });
            if (request.hrEmail.toLowerCase() !== req.user.email.toLowerCase()) return res.status(403).json({ error: 'Forbidden' });

            await this.requestCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: 'rejected', processedBy: req.user.email, processedAt: new Date() } });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async processRequest(req, res) {
        try {
            const { status } = req.body;
            if (status === 'accepted') {
                return this.approveRequest(req, res);
            } else if (status === 'rejected') {
                return this.rejectRequest(req, res);
            } else {
                return res.status(400).json({ error: 'Invalid status' });
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createRequest(req, res) {
        try {
            const { assetId, note, employeeEmail } = req.body;
            if (!assetId || !employeeEmail) return res.status(400).json({ error: 'Asset information and employee email required' });

            const asset = await this.assetCollection.findOne({ _id: new ObjectId(assetId) });
            if (!asset) return res.status(404).json({ error: 'Asset not found' });

            const request = {
                assetId,
                note: note || '',
                status: 'pending',
                employeeEmail,
                hrEmail: asset.hrEmail,
                createdAt: new Date()
            };

            const result = await this.requestCollection.insertOne(request);
            res.json({ success: true, data: { _id: result.insertedId, ...request } });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = RequestController;