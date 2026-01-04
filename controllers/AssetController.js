const { ObjectId } = require('mongodb');

class AssetController {
    constructor(collections) {
        this.assetCollection = collections.assetCollection;
        this.assignedAssetCollection = collections.assignedAssetCollection;
        this.userCollection = collections.userCollection;
        this.employeeAffiliationCollection = collections.employeeAffiliationCollection;
        this.requestCollection = collections.requestCollection;
    }

    async getAssets(req, res) {
        try {
            let query = {};
            const role = req.user.role?.toLowerCase();
            const userEmail = req.user.email.toLowerCase();

            if (role === 'hr') {
                query.hrEmail = userEmail;
            } else if (role === 'employee') {
                if (req.query.quantity === 'available') {
                    query.$or = [
                        { availableQuantity: { $gt: 0 } },
                        { availableQuantity: { $exists: false }, quantity: { $gt: 0 } }
                    ];
                }
            } else {
                return res.json({ data: [], totalPages: 0, totalAssets: 0, totalQuantity: 0, lowStock: 0 });
            }

            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const skip = (page - 1) * limit;

            if (req.query.search) {
                query.name = { $regex: req.query.search, $options: 'i' };
            }
            if (req.query.filter && req.query.filter !== 'all') {
                query.type = req.query.filter;
            }
            if (req.query.quantity === 'available') {
                query.$or = [
                    { availableQuantity: { $gt: 0 } },
                    { availableQuantity: { $exists: false }, quantity: { $gt: 0 } }
                ];
            }

            const assetsList = await this.assetCollection.find(query).skip(skip).limit(limit).toArray();

            for (const asset of assetsList) {
                const correctAvailable = asset.availableQuantity ?? asset.quantity ?? asset.productQuantity ?? 0;
                if (asset.availableQuantity === undefined || asset.availableQuantity < 0 || asset.availableQuantity !== correctAvailable) {
                    await this.assetCollection.updateOne(
                        { _id: asset._id },
                        { $set: { availableQuantity: correctAvailable } }
                    );
                    asset.availableQuantity = correctAvailable;
                }
            }

            const totalAssets = await this.assetCollection.countDocuments(query);
            const summaryResult = await this.assetCollection.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: null,
                        totalQuantity: { $sum: { $ifNull: ["$quantity", { $ifNull: ["$productQuantity", 0] }] } },
                        totalAvailable: { $sum: { $ifNull: ["$availableQuantity", { $ifNull: ["$quantity", { $ifNull: ["$productQuantity", 0] }] }] } },
                        lowStockCount: {
                            $sum: {
                                $cond: [
                                    { $lte: [{ $ifNull: ["$availableQuantity", { $ifNull: ["$quantity", { $ifNull: ["$productQuantity", 0] }] }] }, 5] },
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).toArray();

            const summary = summaryResult[0] || { totalQuantity: 0, totalAvailable: 0, lowStockCount: 0 };
            const totalQuantity = summary.totalAvailable;
            const lowStock = summary.lowStockCount;
            const totalPages = Math.ceil(totalAssets / limit);

            res.json({
                data: assetsList,
                totalPages,
                totalAssets,
                totalQuantity,
                lowStock,
                totalUnits: summary.totalQuantity
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getAssetById(req, res) {
        try {
            const id = req.params.id;
            const result = await this.assetCollection.findOne({ _id: new ObjectId(id) });
            if (result) {
            result.quantity = result.productQuantity ?? result.quantity ?? result.availableQuantity ?? 0;
            result.productQuantity = result.quantity;
            result.availableQuantity = result.availableQuantity ?? result.quantity;
            }
            res.send(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async createAsset(req, res) {
        try {
            console.log('createAsset called', { user: req.user, body: req.body });
            const asset = req.body;
            asset.createdAt = new Date();
            asset.status = 'available';
            asset.quantity = asset.productQuantity || asset.quantity || 0;
            asset.availableQuantity = asset.quantity;
            asset.hrEmail = req.user.email;

            const result = await this.assetCollection.insertOne(asset);
            console.log('createAsset result', { insertedId: result.insertedId, acknowledged: result.acknowledged });
            res.send(result);
        } catch (error) {
            console.error('createAsset error', error);
            res.status(500).json({ error: error.message });
        }
    }

    async updateAsset(req, res) {
        try {
            const id = req.params.id;
            const updateData = req.body;

            const asset = await this.assetCollection.findOne({ _id: new ObjectId(id) });
            if (!asset) return res.status(404).json({ error: 'Asset not found' });

            if (req.user.role === 'hr') {
                if (asset.hrEmail !== req.user.email) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
            }

            const oldQty = Number(asset.productQuantity ?? asset.quantity ?? 0);
            const newQty = Number(updateData.quantity ?? updateData.productQuantity ?? oldQty);
            const diff = newQty - oldQty;

            const finalUpdate = { ...updateData };

            if (updateData.name || updateData.productName) {
                const val = updateData.name || updateData.productName;
                finalUpdate.name = finalUpdate.productName = val;
            }
            if (updateData.type || updateData.productType) {
                const val = updateData.type || updateData.productType;
                finalUpdate.type = finalUpdate.productType = val;
            }
            if (updateData.image || updateData.productImage) {
                const val = updateData.image || updateData.productImage;
                finalUpdate.image = finalUpdate.productImage = val;
            }

            finalUpdate.quantity = finalUpdate.productQuantity = newQty;
            const currentAvailable = Number(asset.availableQuantity ?? oldQty);
            finalUpdate.availableQuantity = Math.max(0, currentAvailable + diff);

            const result = await this.assetCollection.updateOne({ _id: new ObjectId(id) }, { $set: finalUpdate });
            res.send(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async deleteAsset(req, res) {
        try {
            const id = req.params.id;

            // Check if HR owns this asset
            if (req.user.role === 'hr') {
                const asset = await this.assetCollection.findOne({ _id: new ObjectId(id) });
                if (!asset || asset.hrEmail !== req.user.email) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
            }

            const result = await this.assetCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async assignAsset(req, res) {
        try {
            const { email: employeeEmail } = req.body;
            const assetId = req.params.assetId;
            const hrEmail = req.user.email;

            const asset = await this.assetCollection.findOne({ _id: new ObjectId(assetId) });
            if (!asset) return res.status(404).json({ error: 'Asset not found' });
            const currentAvailable = asset.availableQuantity ?? asset.quantity ?? 0;
            if (currentAvailable <= 0) return res.status(400).json({ error: 'Asset out of stock' });

            const employee = await this.userCollection.findOne({ email: employeeEmail });
            if (!employee) return res.status(404).json({ error: 'Employee not found' });

            await this.assetCollection.updateOne({ _id: new ObjectId(assetId) }, { $set: { availableQuantity: currentAvailable - 1 } });

            await this.assignedAssetCollection.insertOne({
                assetId: new ObjectId(assetId),
                assetName: asset.productName || asset.name,
                assetType: asset.productType || asset.type,
                employeeEmail,
                employeeName: employee.name || 'Unknown',
                hrEmail,
                companyName: asset.companyName || 'Unknown',
                assignmentDate: new Date(),
                status: 'assigned'
            });

            const existingAffiliation = await this.employeeAffiliationCollection.findOne({ employeeEmail, hrEmail });
            const isNewAffiliation = !existingAffiliation;

            await this.employeeAffiliationCollection.updateOne(
                { employeeEmail, hrEmail },
                {
                    $set: {
                        employeeName: employee.name || 'Unknown',
                        companyName: asset.companyName || 'Unknown',
                        status: 'active',
                        lastUpdate: new Date()
                    },
                    $setOnInsert: { joinedAt: new Date() }
                },
                { upsert: true }
            );

            if (isNewAffiliation) {
                await this.userCollection.updateOne({ email: hrEmail }, { $inc: { currentEmployees: 1 } });
            }

            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getAnalytics(req, res) {
        try {
            if (req.user.role !== 'hr' && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const hrEmail = req.user.email.toLowerCase();

            let typeDistribution = [];
            try {
                typeDistribution = await this.assetCollection.aggregate([
                    { $match: { hrEmail: { $regex: new RegExp(`^${hrEmail}$`, 'i') } } },
                    { $group: { _id: { $toLower: { $ifNull: ["$productType", "$type"] } }, count: { $sum: 1 } } },
                    {
                        $project: {
                            name: {
                                $cond: [
                                    { $eq: ["$_id", null] }, "Unknown",
                                    {
                                        $cond: [
                                            { $eq: ["$_id", "returnable"] }, "Returnable",
                                            { $cond: [{ $eq: ["$_id", "non-returnable"] }, "Non-returnable", "$_id"] }
                                        ]
                                    }
                                ]
                            },
                            value: "$count",
                            _id: 0
                        }
                    }
                ]).toArray();
            } catch (error) {
                console.error('Error in typeDistribution aggregate:', error);
                typeDistribution = [];
            }

            let topRequests = [];
            try {
                const allRequests = await this.requestCollection.find({ hrEmail: { $regex: new RegExp(`^${hrEmail}$`, 'i') } }).toArray();
                console.log(`Found ${allRequests.length} requests for HR ${hrEmail}`);

                if (allRequests.length > 0) {
                    topRequests = await this.requestCollection.aggregate([
                        { $match: { hrEmail: { $regex: new RegExp(`^${hrEmail}$`, 'i') } } },
                        { $group: { _id: "$assetId", requestCount: { $sum: 1 } } },
                        { $sort: { requestCount: -1 } },
                        { $limit: 5 },
                        {
                            $addFields: {
                                assetObjectId: {
                                    $convert: {
                                        input: "$_id",
                                        to: "objectId",
                                        onError: null,
                                        onNull: null
                                    }
                                }
                            }
                        },
                        {
                            $lookup: {
                                from: "assets",
                                localField: "assetObjectId",
                                foreignField: "_id",
                                as: "assetInfo"
                            }
                        },
                        {
                            $project: {
                                name: {
                                    $let: {
                                        vars: {
                                            asset: { $arrayElemAt: ["$assetInfo", 0] }
                                        },
                                        in: {
                                            $ifNull: [
                                                "$$asset.productName",
                                                { $ifNull: ["$$asset.name", "$_id"] }
                                            ]
                                        }
                                    }
                                },
                                count: "$requestCount",
                                _id: 0
                            }
                        }
                    ]).toArray();
                    console.log(`Top requests:`, topRequests);
                } else {
                    topRequests = [];
                }
            } catch (error) {
                console.error('Error in topRequests aggregate:', error);
                topRequests = [];
            }

            res.json({ success: true, data: { typeDistribution, topRequests } });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = AssetController;