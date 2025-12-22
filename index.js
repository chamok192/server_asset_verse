const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const fs = require('fs');
const { buildAssetDocument, validateAsset } = require('./src/utils/assetSchema');
const { buildUserDocument, validateUser } = require('./src/utils/userSchema');

// Firebase Admin SDK initialization
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8');
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
    origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'],
    credentials: true
}));

app.get('/', (req, res) => {
    res.send('AssetVerse Server is running!');
});

const asyncHandler = fn => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);

const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gtbyi48.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1 }
});

let users, assets, packages, payments, requests, employeeAffiliations, assignedAssets;

const getCollections = async () => {
    if (!users) {
        await client.connect();
        const db = client.db('assetVerse');
        users = db.collection('users');
        assets = db.collection('assets');
        packages = db.collection('packages');
        payments = db.collection('payments');
        requests = db.collection('requests');
        employeeAffiliations = db.collection('employeeAffiliations');
        assignedAssets = db.collection('assignedAssets');
    }
    return { users, assets, packages, payments, requests, employeeAffiliations, assignedAssets };
};

const verifyHR = (req, res, next) => {
    const role = req.user.role?.toLowerCase();
    if (!['hr', 'admin'].includes(role)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};

app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const user = await users.findOne({ email: req.body.email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const token = jwt.sign(
        { email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
    );

    res.json({ token, user });
}));

app.post('/api/users', asyncHandler(async (req, res) => {
    const { valid, errors } = validateUser(req.body);
    if (!valid) return res.status(400).json({ errors });

    if (await users.findOne({ email: req.body.email }))
        return res.status(409).json({ error: 'User exists' });

    const userDoc = buildUserDocument(req.body);
    const result = await users.insertOne(userDoc);

    res.json({ success: true, data: { _id: result.insertedId, ...userDoc } });
}));

app.get('/api/users/profile', verifyToken, asyncHandler(async (req, res) => {
    const user = await users.findOne({ email: req.user.email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role === 'HR') {
        const latestPayment = await payments.findOne({ email: req.user.email, status: 'completed' }, { sort: { paymentDate: -1 } });
        if (latestPayment) {
            const pkg = await packages.findOne({ id: latestPayment.packageId });
            if (pkg) {
                await users.updateOne({ email: req.user.email }, { $set: { subscription: latestPayment.packageId, packageLimit: pkg.employeeLimit, subscriptionDate: latestPayment.paymentDate } });
                user.subscription = latestPayment.packageId;
                user.packageLimit = pkg.employeeLimit;
                user.subscriptionDate = latestPayment.paymentDate;
            }
        }

        const actualCount = await employeeAffiliations.countDocuments({ hrEmail: user.email, status: 'active' });
        if (user.currentEmployees !== actualCount) {
            await users.updateOne({ email: user.email }, { $set: { currentEmployees: actualCount } });
            user.currentEmployees = actualCount;
        }
    } else if (user.role === 'Employee') {
        const affiliations = await employeeAffiliations.find({ employeeEmail: user.email, status: 'active' }).toArray();
        user.affiliations = affiliations;
    }

    res.json(user);
}));

app.patch('/api/users/profile', verifyToken, asyncHandler(async (req, res) => {
    const allowed = ['name', 'phone', 'address', 'profileImage', 'dateOfBirth', 'companyName', 'companyLogo'];
    const updates = Object.fromEntries(
        Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    updates.updatedAt = new Date();

    const result = await users.findOneAndUpdate(
        { email: req.user.email },
        { $set: updates },
        { returnDocument: 'after' }
    );

    res.json(result.value);
}));

app.get('/api/users', verifyToken, asyncHandler(async (req, res) => {
    res.json(await users.find().toArray());
}));

app.get('/api/users/email/:email', asyncHandler(async (req, res) => {
    const user = await users.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const affiliations = await employeeAffiliations.find({ employeeEmail: user.email, status: 'active' }).toArray();

    res.json({
        success: true,
        data: {
            _id: user._id,
            email: user.email,
            name: user.name,
            role: user.role,
            profileImage: user.profileImage,
            dateOfBirth: user.dateOfBirth,
            companyName: user.companyName,
            companyLogo: user.companyLogo,
            affiliations: affiliations,
            packageLimit: user.packageLimit,
            currentEmployees: user.currentEmployees,
            subscription: user.subscription
        }
    });
}));

app.get('/api/packages', async (req, res) => {
    try {
        const allPackages = await packages.find().sort({ price: 1 }).toArray();
        res.json({ success: true, data: allPackages });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* EMPLOYEE LIMIT CHECK */
app.get('/api/users/limit-check', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const hr = await users.findOne({ email: req.user.email });
    if (!hr) return res.status(404).json({ error: 'HR not found' });


    const actualCount = await employeeAffiliations.countDocuments({ hrEmail: req.user.email, status: 'active' });

    if (hr.currentEmployees !== actualCount) {
        await users.updateOne({ email: req.user.email }, { $set: { currentEmployees: actualCount } });
        hr.currentEmployees = actualCount;
    }

    const canAdd = hr.currentEmployees < hr.packageLimit;

    res.json({
        success: true,
        data: {
            currentEmployees: hr.currentEmployees || 0,
            packageLimit: hr.packageLimit || 3,
            canAdd: canAdd,
            message: canAdd ? 'Can add employees' : 'Employee limit reached. Please upgrade package.'
        }
    });
}));

app.post('/api/assets', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const { valid, errors } = validateAsset(req.body);
    if (!valid) return res.status(400).json({ errors });

    const hr = await users.findOne({ email: req.user.email });
    const asset = buildAssetDocument({
        ...req.body,
        hrEmail: req.user.email,
        companyName: hr?.companyName || ''
    });

    const result = await assets.insertOne(asset);
    res.json({ _id: result.insertedId, ...asset });
}));

app.get('/api/assets', verifyToken, asyncHandler(async (req, res) => {
    let query = {};
    const role = req.user.role?.toLowerCase();
    if (role === 'hr') {
        query.hrEmail = req.user.email;
    }
    // Show all assets for employees

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    if (req.query.search) {
        query.productName = { $regex: req.query.search, $options: 'i' };
    }
    if (req.query.filter && req.query.filter !== 'all') {
        query.productType = req.query.filter;
    }
    if (req.query.quantity === 'available') {
        query.availableQuantity = { $gt: 0 };
    }

    if (req.query.noPagination === 'true') {
        const result = await assets.find(query).toArray();
        return res.json(result);
    }

    const total = await assets.countDocuments(query);

    // Calculate stats
    const statsPipeline = [
        { $match: query },
        {
            $group: {
                _id: null,
                totalQuantity: {
                    $sum: { $toInt: { $ifNull: ["$productQuantity", { $ifNull: ["$quantity", 0] }] } }
                },
                availableCount: {
                    $sum: {
                        $cond: [{ $gt: [{ $toInt: { $ifNull: ["$availableQuantity", { $ifNull: ["$quantity", 0] }] } }, 0] }, 1, 0]
                    }
                },
                lowStock: {
                    $sum: {
                        $cond: [{ $lte: [{ $toInt: { $ifNull: ["$availableQuantity", { $ifNull: ["$quantity", 0] }] } }, 5] }, 1, 0]
                    }
                }
            }
        }
    ];
    const statsResult = await assets.aggregate(statsPipeline).toArray();
    const stats = statsResult.length > 0 ? statsResult[0] : { totalQuantity: 0, availableCount: 0, lowStock: 0 };

    const result = await assets.find(query)
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .toArray();

    res.json({
        data: result,
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalAssets: total,
        totalQuantity: stats.totalQuantity,
        availableCount: stats.availableCount || 0,
        lowStock: stats.lowStock
    });
}));

app.get('/api/hr/analytics', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const hrEmail = req.user.email;

    // Type distribution
    const typeDistribution = await assets.aggregate([
        { $match: { hrEmail } },
        {
            $group: {
                _id: { $toLower: { $ifNull: ["$productType", "$type"] } },
                count: { $sum: 1 }
            }
        },
        {
            $project: {
                name: {
                    $cond: [
                        { $eq: ["$_id", "returnable"] },
                        "Returnable",
                        { $cond: [{ $eq: ["$_id", "non-returnable"] }, "Non-returnable", "$_id"] }
                    ]
                },
                value: "$count",
                _id: 0
            }
        }
    ]).toArray();

    // Top requested assets
    const topRequests = await requests.aggregate([
        { $match: { hrEmail } },
        { $group: { _id: "$assetId", requestCount: { $sum: 1 } } },
        { $sort: { requestCount: -1 } },
        { $limit: 5 },
        {
            $addFields: {
                assetObjectId: {
                    $convert: { input: "$_id", to: "objectId", onError: null, onNull: null }
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
        { $unwind: "$assetInfo" },
        {
            $project: {
                name: { $ifNull: ["$assetInfo.productName", "$assetInfo.name"] },
                count: "$requestCount",
                _id: 0
            }
        }
    ]).toArray();

    res.json({
        success: true,
        data: {
            typeDistribution,
            topRequests
        }
    });
}));

app.get('/api/assets/:id', verifyToken, asyncHandler(async (req, res) => {
    const asset = await assets.findOne({ _id: new ObjectId(req.params.id) });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (req.user.role === 'HR' && asset.hrEmail !== req.user.email) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(asset);
}));

app.patch('/api/assets/:id', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const asset = await assets.findOne({ _id: new ObjectId(req.params.id) });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.hrEmail !== req.user.email) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const { valid, errors } = validateAsset(req.body);
    if (!valid) return res.status(400).json({ errors });

    const updates = buildAssetDocument(req.body);
    delete updates.createdAt;

    const result = await assets.findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: updates },
        { returnDocument: 'after' }
    );

    res.json(result.value);
}));

app.delete('/api/assets/:id', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const asset = await assets.findOne({ _id: new ObjectId(req.params.id) });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.hrEmail !== req.user.email) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    await assets.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
}));

app.get('/api/employee-assets', verifyToken, asyncHandler(async (req, res) => {
    const query = { employeeEmail: req.user.email };
    if (req.query.search) {
        query.assetName = { $regex: req.query.search, $options: 'i' };
    }
    if (req.query.filter && req.query.filter !== 'all') {
        query.assetType = req.query.filter;
    }

    const employeeAssets = await assignedAssets.find(query).toArray();

    // Populate asset details
    const populatedAssets = await Promise.all(employeeAssets.map(async (assignment) => {
        if (!assignment.assetName || assignment.assetName === 'Unknown Asset' || !assignment.assetType) {
            try {
                const asset = await assets.findOne({ _id: new ObjectId(assignment.assetId) });
                if (asset) {
                    return {
                        ...assignment,
                        assetName: assignment.assetName || asset.productName || asset.name || 'Unknown Asset',
                        assetImage: assignment.assetImage || asset.productImage || asset.image || '',
                        assetType: assignment.assetType || asset.productType || asset.type || 'Unknown'
                    };
                }
            } catch (e) {
            }
        }
        return assignment;
    }));

    res.json({ success: true, data: populatedAssets });
}));

app.post('/api/employee-assets/:id/return', verifyToken, asyncHandler(async (req, res) => {
    const assignedAssetId = req.params.id;
    const assignment = await assignedAssets.findOne({ _id: new ObjectId(assignedAssetId) });

    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.employeeEmail !== req.user.email) return res.status(403).json({ error: 'Not assigned to you' });
    if (assignment.status === 'returned') return res.status(400).json({ error: 'Already returned' });

    await assignedAssets.updateOne(
        { _id: new ObjectId(assignedAssetId) },
        { $set: { status: 'returned', returnDate: new Date() } }
    );

    await assets.updateOne(
        { _id: new ObjectId(assignment.assetId) },
        { $inc: { availableQuantity: 1 } }
    );

    await requests.updateOne(
        { assetId: assignment.assetId, employeeEmail: req.user.email, status: 'approved' },
        { $set: { status: 'returned' } }
    );

    res.json({ success: true });
}));
app.delete('/api/employee-assets/:id', verifyToken, asyncHandler(async (req, res) => {
    const assignedAssetId = req.params.id;
    const assignment = await assignedAssets.findOne({ _id: new ObjectId(assignedAssetId) });

    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.employeeEmail !== req.user.email) return res.status(403).json({ error: 'Not assigned to you' });

    await assignedAssets.deleteOne({ _id: new ObjectId(assignedAssetId) });

    await assets.updateOne(
        { _id: new ObjectId(assignment.assetId) },
        { $inc: { availableQuantity: 1 } }
    );

    res.json({ success: true });
}));
app.get('/api/employees', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const hrEmail = req.user.email;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const query = { hrEmail, status: { $ne: 'removed' } }; // Robust query

    const total = await employeeAffiliations.countDocuments(query);
    const affiliations = await employeeAffiliations.find(query)
        .skip(skip)
        .limit(limit)
        .sort({ affiliationDate: -1 }) // Sort by newest joined
        .toArray();

    const employeesWithCounts = await Promise.all(affiliations.map(async (aff) => {
        const user = await users.findOne({ email: aff.employeeEmail }, { projection: { name: 1, email: 1, profileImage: 1 } });
        const assetCount = await assignedAssets.countDocuments({ employeeEmail: aff.employeeEmail, hrEmail, status: 'assigned' });
        return {
            ...user,
            _id: aff._id, // Using affiliation _id for management
            userId: user?._id,
            assetsCount: assetCount,
            affiliationDate: aff.affiliationDate
        };
    }));

    res.json({
        success: true,
        data: employeesWithCounts,
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalEmployees: total
    });
}));

app.delete('/api/employees/:id', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const hrEmail = req.user.email;
    const affiliationId = req.params.id;

    const affiliation = await employeeAffiliations.findOne({ _id: new ObjectId(affiliationId), hrEmail });
    if (!affiliation) return res.status(404).json({ error: 'Affiliation not found' });

    await employeeAffiliations.deleteOne({ _id: new ObjectId(affiliationId) });

    // Update HR's employee count
    const actualCount = await employeeAffiliations.countDocuments({ hrEmail, status: 'active' });
    await users.updateOne({ email: hrEmail }, { $set: { currentEmployees: actualCount } });

    res.json({ success: true });
}));
app.get('/api/my-team', verifyToken, asyncHandler(async (req, res) => {
    const userEmail = req.user.email;

    // Find affiliated HRs
    const affiliations = await employeeAffiliations.find({ employeeEmail: userEmail, status: 'active' }).toArray();
    if (affiliations.length === 0) {
        return res.json({ success: true, data: [] });
    }

    const hrEmails = affiliations.map(a => a.hrEmail);

    // Find team employees
    const teamAffiliations = await employeeAffiliations.find({
        hrEmail: { $in: hrEmails },
        employeeEmail: { $ne: userEmail },
        status: 'active'
    }).toArray();

    const teamMemberEmails = [...new Set(teamAffiliations.map(a => a.employeeEmail))];

    const teamMembers = await users.find({
        email: { $in: teamMemberEmails }
    }).toArray();

    res.json({ success: true, data: teamMembers });
}));

app.post('/api/requests', verifyToken, asyncHandler(async (req, res) => {
    const { assetId, note, status, employeeEmail } = req.body;
    if (!assetId || !employeeEmail) return res.status(400).json({ error: 'Missing required fields' });

    let asset;
    try {
        asset = await assets.findOne({ _id: new ObjectId(assetId) });
    } catch (e) {
        return res.status(400).json({ error: 'Invalid asset ID' });
    }
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const request = {
        assetId,
        note: note || '',
        status: status || 'pending',
        employeeEmail,
        hrEmail: asset.hrEmail,
        createdAt: new Date()
    };

    const result = await requests.insertOne(request);
    res.json({ success: true, data: { _id: result.insertedId, ...request } });
}));

app.get('/api/requests', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const hrEmail = req.user.email;
    const hrRequests = await requests.find({
        $or: [
            { hrEmail: hrEmail },
            { hrEmail: { $exists: false } },
            { hrEmail: null }
        ],
        status: { $in: ['pending', 'approved', 'rejected'] }
    }).toArray();

    const populatedRequests = [];
    await Promise.all(hrRequests.map(async (requestDoc) => {
        const employee = await users.findOne({ email: requestDoc.employeeEmail }, { projection: { name: 1, email: 1 } });
        let asset = null;
        try {
            asset = await assets.findOne({ _id: new ObjectId(requestDoc.assetId) });
        } catch (e) { }

        // Migration safety check
        const ownerEmail = requestDoc.hrEmail || (asset ? asset.hrEmail : null);

        if (ownerEmail === hrEmail) {
            populatedRequests.push({
                ...requestDoc,
                employee: employee ? { name: employee.name, email: employee.email } : { name: 'Unknown', email: requestDoc.employeeEmail },
                asset: asset ? {
                    productName: asset.productName || asset.name,
                    availableQuantity: asset.availableQuantity ?? asset.quantity
                } : { productName: 'Unknown Asset' }
            });
        }
    }));

    res.json({ success: true, data: populatedRequests.filter(r => r.status === 'pending') });
}));

app.patch('/api/requests/:id', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const { status } = req.body;
    let request;
    try {
        request = await requests.findOne({ _id: new ObjectId(req.params.id) });
    } catch (e) {
        return res.status(400).json({ error: 'Invalid request ID' });
    }
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.hrEmail !== req.user.email) return res.status(403).json({ error: 'Forbidden' });

    if (status === 'accepted') {
        const hr = await users.findOne({ email: req.user.email });
        const isAffiliated = await employeeAffiliations.findOne({ employeeEmail: request.employeeEmail, hrEmail: req.user.email, status: 'active' });
        if (!isAffiliated && hr.currentEmployees >= hr.packageLimit) {
            return res.status(400).json({ error: 'Plan limit reached. Please upgrade your package.' });
        }
    }

    await requests.updateOne({ _id: new ObjectId(req.params.id) }, {
        $set: {
            status: status === 'accepted' ? 'approved' : status,
            approvalDate: status === 'accepted' ? new Date() : null,
            processedBy: req.user.email
        }
    });

    if (status === 'accepted') {
        const asset = await assets.findOne({ _id: new ObjectId(request.assetId) });
        if (!asset || asset.availableQuantity <= 0) {
            return res.status(400).json({ error: 'Asset not available or out of stock' });
        }

        await assets.updateOne(
            { _id: new ObjectId(request.assetId) },
            { $inc: { availableQuantity: -1 } }
        );

        const employee = await users.findOne({ email: request.employeeEmail });
        const hr = await users.findOne({ email: request.hrEmail });

        // Handle both old and new asset schema
        const assetName = asset.productName || asset.name || 'Unknown Asset';
        const assetImage = asset.productImage || asset.image || '';
        const assetType = asset.productType || asset.type || 'Unknown';

        await assignedAssets.insertOne({
            assetId: new ObjectId(request.assetId),
            assetName: assetName,
            assetImage: assetImage,
            assetType: assetType,
            employeeEmail: request.employeeEmail,
            employeeName: employee?.name || 'Unknown',
            hrEmail: request.hrEmail,
            companyName: hr?.companyName || 'Unknown',
            assignmentDate: new Date(),
            status: 'assigned'
        });

        if (hr && hr.companyName) {
            await employeeAffiliations.updateOne(
                { employeeEmail: request.employeeEmail, hrEmail: request.hrEmail },
                {
                    $set: {
                        employeeName: employee?.name || 'Unknown',
                        companyName: hr.companyName,
                        companyLogo: hr.companyLogo,
                        affiliationDate: new Date(),
                        status: 'active'
                    }
                },
                { upsert: true }
            );

            // Update HR's employee count
            const actualCount = await employeeAffiliations.countDocuments({ hrEmail: request.hrEmail, status: 'active' });
            await users.updateOne({ email: request.hrEmail }, { $set: { currentEmployees: actualCount } });
        }
    }

    res.json({ success: true });
}));

app.post('/api/assets/:id/assign', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const { email: employeeEmail } = req.body;
    const { id: assetId } = req.params;
    const hrEmail = req.user.email;

    if (!employeeEmail) return res.status(400).json({ error: 'Employee email is required' });

    const hr = await users.findOne({ email: hrEmail });
    if (!hr) return res.status(404).json({ error: 'HR not found' });

    const asset = await assets.findOne({ _id: new ObjectId(assetId), hrEmail });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.availableQuantity <= 0) return res.status(400).json({ error: 'Asset out of stock' });

    const employee = await users.findOne({ email: employeeEmail });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    // 1. Update Asset Quantity
    await assets.updateOne({ _id: new ObjectId(assetId) }, {
        $inc: { availableQuantity: -1 }
    });

    // 2. Create Assigned Asset Record
    // Handle both old and new asset schema
    const assetName = asset.productName || asset.name || 'Unknown Asset';
    const assetImage = asset.productImage || asset.image || '';
    const assetType = asset.productType || asset.type || 'Unknown';

    await assignedAssets.insertOne({
        assetId: new ObjectId(assetId),
        assetName: assetName,
        assetImage: assetImage,
        assetType: assetType,
        employeeEmail: employeeEmail,
        employeeName: employee.name,
        hrEmail: hrEmail,
        companyName: hr.companyName,
        assignmentDate: new Date(),
        status: 'assigned'
    });

    if (hr.companyName) {
        await employeeAffiliations.updateOne(
            { employeeEmail: employeeEmail, hrEmail: hrEmail },
            {
                $set: {
                    employeeName: employee.name,
                    companyName: hr.companyName,
                    companyLogo: hr.companyLogo,
                    affiliationDate: new Date(),
                    status: 'active'
                }
            },
            { upsert: true }
        );

        // Update HR's employee count
        const actualCount = await employeeAffiliations.countDocuments({ hrEmail, status: 'active' });
        await users.updateOne({ email: hrEmail }, { $set: { currentEmployees: actualCount } });
    }

    // 4. Create a request record for tracking
    await requests.insertOne({
        assetId: assetId,
        assetName: asset.productName,
        assetType: asset.productType,
        hrEmail: hrEmail,
        companyName: hr.companyName,
        requesterEmail: employeeEmail,
        requesterName: employee.name,
        status: 'approved',
        requestDate: new Date(),
        approvalDate: new Date(),
        processedBy: hrEmail
    });

    res.json({ success: true, message: 'Asset assigned successfully' });
}));

app.post('/api/payments/create-checkout', verifyToken, asyncHandler(async (req, res) => {
    const { packageId, email } = req.body;

    if (!packageId || !email) {
        return res.status(400).json({ success: false, error: 'Missing required fields: packageId and email' });
    }

    try {
        const pkg = await packages.findOne({ id: packageId });
        if (!pkg) return res.status(404).json({ success: false, error: 'Package not found' });


        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: pkg.name,
                            description: `${pkg.employeeLimit} employee limit`
                        },
                        unit_amount: Math.round(pkg.price * 100)
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:5174'}/hr/payments?payment=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5174'}/hr/upgrade`,
            customer_email: email,
            billing_address_collection: 'auto',
            metadata: {
                packageId: packageId,
                email: email,
                packageName: pkg.name
            }
        });

        res.json({
            success: true,
            data: {
                sessionId: session.id,
                url: session.url
            }
        });
    } catch (error) {
        console.error('Error creating checkout session:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
}));

// Helper function to process payment and update user
const processPayment = async (sessionId, packageId, email, packageName, amountTotal) => {
    const pkg = await packages.findOne({ id: packageId });
    if (!pkg) {
        console.error('Package not found:', packageId);
        return null;
    }

    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    await payments.insertOne({
        sessionId: sessionId,
        transactionId: transactionId,
        packageId: packageId,
        packageName: packageName,
        amount: amountTotal / 100,
        email: email,
        status: 'completed',
        paymentDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
    });

    await users.findOneAndUpdate(
        { email: email },
        {
            $set: {
                subscription: packageId,
                packageLimit: pkg.employeeLimit,
                subscriptionDate: new Date(),
                updatedAt: new Date()
            }
        },
        { returnDocument: 'after' }
    );

    return transactionId;
};

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        if (!webhookSecret) {
            console.error('STRIPE_WEBHOOK_SECRET not set in environment variables');
            event = JSON.parse(req.body.toString());
        } else {
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        }
    } catch (error) {
        console.error('Webhook signature verification failed:', error.message);
        return res.status(400).json({ error: `Webhook Error: ${error.message}` });
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        try {
            const { packageId, email, packageName } = session.metadata;
            await processPayment(session.id, packageId, email, packageName, session.amount_total);
        } catch (error) {
            console.error('Error processing webhook:', error);
        }
    }

    res.json({ received: true });
}));

app.get('/api/payments/session/:sessionId', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        let payment = await payments.findOne({ sessionId: sessionId });

        // If payment not in DB yet but Stripe confirms it was paid, manually process it
        if (!payment && session.payment_status === 'paid' && session.metadata) {
            const { packageId, email, packageName } = session.metadata;
            await processPayment(session.id, packageId, email, packageName, session.amount_total);
            payment = await payments.findOne({ sessionId: sessionId });
        }

        if (!payment) {
            return res.json({
                success: false,
                data: {
                    session: {
                        status: session.status,
                        paymentStatus: session.payment_status
                    },
                    message: 'Payment is being processed'
                }
            });
        }

        res.json({
            success: true,
            data: {
                payment: payment,
                session: {
                    status: session.status,
                    paymentStatus: session.payment_status
                }
            }
        });
    } catch (error) {
        console.error('Error checking payment session:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
}));

app.get('/api/payments/history', verifyToken, asyncHandler(async (req, res) => {
    const userEmail = req.user.email;

    const paymentHistory = await payments
        .find({ email: userEmail, status: 'completed' })
        .sort({ paymentDate: -1 })
        .toArray();

    const formatted = paymentHistory.map(payment => ({
        _id: payment._id,
        transactionId: payment.transactionId || payment.paymentIntentId,
        amount: payment.amount,
        packageName: payment.packageName || payment.packageId,
        paymentDate: payment.paymentDate || payment.updatedAt,
        status: 'completed',
        phoneNumber: payment.phoneNumber,
        email: payment.email
    }));

    res.json({ success: true, data: formatted });
}));

app.delete('/api/payments/:id', verifyToken, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await payments.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 1) {
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, error: 'Payment not found' });
    }
}));

app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
});

module.exports = app;
