const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { buildUserDocument, validateUser } = require('./src/utils/userSchema');
const { buildAssetDocument, validateAsset } = require('./src/utils/assetSchema');

const app = express();
const port = process.env.PORT || 3000;

/*  MIDDLEWARE  */
app.use(express.json());
app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'],
    credentials: true
}));

const asyncHandler = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

/*  DATABASE  */
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gtbyi48.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1 }
});

let users, assets, packages, payments, requests;

/*  ROLE CHECK  */
const verifyHR = (req, res, next) => {
    if (!['HR', 'Admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};

/*  AUTH  */
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

/*  USERS  */
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

    // Check if user has completed payments and update subscription if needed
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


        const actualCount = await users.countDocuments({
            role: 'Employee',
            'companies.hrEmail': user.email
        });
        if (user.currentEmployees !== actualCount) {
            await users.updateOne({ email: user.email }, { $set: { currentEmployees: actualCount } });
            user.currentEmployees = actualCount;
        }
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
            companies: user.companies || [],
            packageLimit: user.packageLimit,
            currentEmployees: user.currentEmployees,
            subscription: user.subscription
        }
    });
}));

/* PACKAGES */
app.get('/api/packages', asyncHandler(async (req, res) => {
    const allPackages = await packages.find().sort({ price: 1 }).toArray();
    res.json({ success: true, data: allPackages });
}));

/* EMPLOYEE LIMIT CHECK */
app.get('/api/users/limit-check', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const hr = await users.findOne({ email: req.user.email });
    if (!hr) return res.status(404).json({ error: 'HR not found' });


    const actualCount = await users.countDocuments({
        role: 'Employee',
        companies: { $elemMatch: { hrEmail: req.user.email } }
    });

    if (hr.currentEmployees !== actualCount) {
        await users.updateOne({ email: req.user.email }, { $set: { currentEmployees: actualCount } });
        hr.currentEmployees = actualCount;
    }

    const canAdd = hr.currentEmployees < hr.packageLimit;

    res.json({
        success: true,
        data: {
            currentEmployees: hr.currentEmployees || 0,
            packageLimit: hr.packageLimit || 5,
            canAdd: canAdd,
            message: canAdd ? 'Can add employees' : 'Employee limit reached. Please upgrade package.'
        }
    });
}));

/* ASSETS */
app.post('/api/assets', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const { valid, errors } = validateAsset(req.body);
    if (!valid) return res.status(400).json({ errors });

    const asset = buildAssetDocument(req.body);
    asset.availableQuantity = asset.quantity;
    asset.hrEmail = req.user.email;

    const result = await assets.insertOne(asset);
    res.json({ _id: result.insertedId, ...asset });
}));

app.get('/api/assets', verifyToken, asyncHandler(async (req, res) => {
    let query = {};
    if (req.user.role === 'HR') {
        query.hrEmail = req.user.email;
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Add filtering
    if (req.query.search) {
        query.name = { $regex: req.query.search, $options: 'i' };
    }
    if (req.query.filter && req.query.filter !== 'all') {
        query.type = req.query.filter;
    }
    if (req.query.quantity === 'available') { // For request asset grid
        query.quantity = { $gt: 0 };
    }

    if (req.query.noPagination === 'true') {
        const result = await assets.find(query).toArray();
        return res.json(result);
    }

    const total = await assets.countDocuments(query);

    // Calculate stats using aggregation
    const statsPipeline = [
        { $match: query },
        {
            $group: {
                _id: null,
                totalQuantity: { $sum: { $toInt: "$quantity" } }, // Ensure quantity is treated as number
                availableCount: {
                    $sum: {
                        $cond: [{ $gt: [{ $toInt: "$quantity" }, 0] }, 1, 0]
                    }
                },
                lowStock: {
                    $sum: {
                        $cond: [{ $lte: [{ $toInt: "$quantity" }, 5] }, 1, 0]
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

    // 1. Distribution by Type (Pie Chart)
    const typeDistribution = await assets.aggregate([
        { $match: { hrEmail } },
        { $group: { _id: "$type", count: { $sum: 1 } } },
        { $project: { name: "$_id", value: "$count", _id: 0 } }
    ]).toArray();

    // 2. Top 5 Requested Assets (Bar Chart)
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
                name: "$assetInfo.name",
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

/* EMPLOYEE ASSETS */
app.get('/api/employee-assets', verifyToken, asyncHandler(async (req, res) => {
    const employeeAssets = await assets.find({ assignedTo: req.user.email }).toArray();

    // Populate with HR company info
    const populatedAssets = await Promise.all(employeeAssets.map(async (asset) => {
        const hr = await users.findOne({ email: asset.hrEmail });
        return {
            _id: asset._id,
            assetName: asset.name,
            assetImage: asset.image,
            assetType: asset.type,
            companyName: hr?.companyName || 'Unknown',
            requestDate: asset.assignedAt || asset.updatedAt, // Assuming assignedAt is set
            approvalDate: asset.assignedAt || asset.updatedAt,
            status: 'Approved',
            canReturn: asset.type === 'returnable'
        };
    }));

    res.json({ success: true, data: populatedAssets });
}));

app.post('/api/employee-assets/:id/return', verifyToken, asyncHandler(async (req, res) => {
    const asset = await assets.findOne({ _id: new ObjectId(req.params.id) });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.assignedTo !== req.user.email) return res.status(403).json({ error: 'Not assigned to you' });

    // Return the asset
    await assets.updateOne({ _id: new ObjectId(req.params.id) }, { $unset: { assignedTo: 1, assignedAt: 1 }, $inc: { quantity: 1 } });

    // Check if employee has other assets from this HR
    const otherAssets = await assets.countDocuments({ assignedTo: req.user.email, hrEmail: asset.hrEmail });
    if (otherAssets === 0) {
        // Remove affiliation
        await users.updateOne({ email: req.user.email }, { $pull: { companies: { hrEmail: asset.hrEmail } } });
    }

    res.json({ success: true });
}));
/* EMPLOYEES */
app.get('/api/employees', verifyToken, verifyHR, asyncHandler(async (req, res) => {
    const hr = await users.findOne({ email: req.user.email });
    if (!hr || !hr.companyName) return res.status(400).json({ error: 'HR company not found' });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const query = { companies: { $elemMatch: { companyName: hr.companyName } }, role: 'Employee' };

    const total = await users.countDocuments(query);
    const employees = await users.find(query)
        .skip(skip)
        .limit(limit)
        .toArray();

    const employeesWithCounts = await Promise.all(employees.map(async (emp) => {
        const assetCount = await assets.countDocuments({ assignedTo: emp.email });
        return { ...emp, assetsCount: assetCount };
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
    const hr = await users.findOne({ email: req.user.email });
    if (!hr || !hr.companyName) return res.status(400).json({ error: 'HR company not found' });

    const employee = await users.findOne({ _id: new ObjectId(req.params.id), companies: { $elemMatch: { companyName: hr.companyName } } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    await users.updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { companies: { companyName: hr.companyName } } });
    await users.updateOne({ email: req.user.email }, { $inc: { currentEmployees: -1 } });

    res.json({ success: true });
}));
app.get('/api/my-team', verifyToken, asyncHandler(async (req, res) => {
    const user = await users.findOne({ email: req.user.email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.companies || !Array.isArray(user.companies) || user.companies.length === 0) {
        return res.json({ success: true, data: [] });
    }

    const companyNames = user.companies.map(c => c.companyName);

    const teamMembers = await users.find({
        role: 'Employee',
        email: { $ne: req.user.email },
        companies: { $elemMatch: { companyName: { $in: companyNames } } }
    }).toArray();

    res.json({ success: true, data: teamMembers });
}));

/* REQUESTS */
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
    const hrRequests = await requests.find({ hrEmail: req.user.email, status: 'pending' }).toArray();

    // Populate employee and asset data
    const populatedRequests = await Promise.all(hrRequests.map(async (req) => {
        const employee = await users.findOne({ email: req.employeeEmail }, { projection: { name: 1, email: 1 } });
        let asset = null;
        try {
            asset = await assets.findOne({ _id: new ObjectId(req.assetId) }, { projection: { name: 1, quantity: 1 } });
        } catch (e) {
            // Invalid assetId, skip
        }
        return {
            ...req,
            employee: employee ? { name: employee.name, email: employee.email } : { name: 'Unknown', email: req.employeeEmail },
            asset: asset ? { name: asset.name, quantity: asset.quantity } : { name: 'Unknown Asset' }
        };
    }));

    res.json({ success: true, data: populatedRequests });
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

    await requests.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });

    if (status === 'accepted') {
        // Check asset availability
        const asset = await assets.findOne({ _id: new ObjectId(request.assetId) });
        if (!asset || asset.quantity <= 0) {
            return res.status(400).json({ error: 'Asset not available or out of stock' });
        }

        // Assign asset to employee
        try {
            await assets.updateOne({ _id: new ObjectId(request.assetId) }, { $set: { assignedTo: request.employeeEmail, assignedAt: new Date() }, $inc: { quantity: -1 } });
        } catch (e) {
            return res.status(400).json({ error: 'Invalid asset ID in request' });
        }

        // Affiliate employee with company if not already affiliated
        const hr = await users.findOne({ email: request.hrEmail });
        if (hr && hr.companyName) {

            const isAffiliated = await users.findOne({
                email: request.employeeEmail,
                'companies.hrEmail': request.hrEmail
            });

            if (!isAffiliated) {

                const actualCount = await users.countDocuments({
                    role: 'Employee',
                    'companies.hrEmail': request.hrEmail
                });

                if (actualCount >= (hr.packageLimit || 5)) {

                    await requests.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'pending' } });

                    await assets.updateOne({ _id: new ObjectId(request.assetId) }, { $inc: { quantity: 1 }, $unset: { assignedTo: 1, assignedAt: 1 } });


                    await users.updateOne({ email: request.hrEmail }, { $set: { currentEmployees: actualCount } });

                    return res.status(403).json({ error: 'Employee limit reached. Please upgrade your plan.' });
                }

                const result = await users.updateOne(
                    { email: request.employeeEmail },
                    { $addToSet: { companies: { companyName: hr.companyName, hrEmail: request.hrEmail, joinedAt: new Date() } } }
                );

                if (result.modifiedCount > 0) {

                    const actualCount = await users.countDocuments({
                        role: 'Employee',
                        'companies.hrEmail': request.hrEmail
                    });
                    await users.updateOne({ email: request.hrEmail }, { $set: { currentEmployees: actualCount } });
                }
            }
        }
    }

    res.json({ success: true });
}));

/*  PAYMENTS  */
app.post('/api/payments/create-checkout', verifyToken, asyncHandler(async (req, res) => {
    const { packageId, email } = req.body;
    console.log('Creating checkout session:', { packageId, email });

    if (!packageId || !email) {
        return res.status(400).json({ success: false, error: 'Missing required fields: packageId and email' });
    }

    try {
        const pkg = await packages.findOne({ id: packageId });
        console.log('Found package:', pkg);
        if (!pkg) return res.status(404).json({ success: false, error: 'Package not found' });


        console.log('Stripe success_url:', `${process.env.FRONTEND_URL || 'http://localhost:5174'}/hr/payments?payment=success`);

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

        console.log('Checkout session created:', session.id);

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

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        if (!webhookSecret) {
            console.error('STRIPE_WEBHOOK_SECRET not set in environment variables');
            // For development: accept webhook without signature verification
            event = JSON.parse(req.body.toString());
        } else {
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        }
    } catch (error) {
        console.error('Webhook signature verification failed:', error.message);
        return res.status(400).json({ error: `Webhook Error: ${error.message}` });
    }

    console.log('Received webhook event:', event.type);

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        try {
            const { packageId, email, packageName } = session.metadata;
            const pkg = await packages.findOne({ id: packageId });

            if (!pkg) {
                console.error('Package not found:', packageId);
                return res.json({ received: true });
            }

            const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

            console.log('Processing payment for email:', email, 'amount:', session.amount_total / 100);

            // Store payment record
            const paymentResult = await payments.insertOne({
                sessionId: session.id,
                transactionId: transactionId,
                packageId: packageId,
                packageName: packageName,
                amount: session.amount_total / 100,
                email: email,
                status: 'completed',
                paymentDate: new Date(),
                createdAt: new Date(),
                updatedAt: new Date()
            });

            console.log('Payment stored:', paymentResult.insertedId);

            // Update user with new package
            const userUpdateResult = await users.findOneAndUpdate(
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

            console.log('User updated:', userUpdateResult.value?.email);
        } catch (error) {
            console.error('Error processing webhook:', error);
        }
    }

    res.json({ received: true });
}));

app.get('/api/payments/session/:sessionId', asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    try {
        console.log('Checking payment session:', sessionId);

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        console.log('Stripe session status:', session.status, 'payment_status:', session.payment_status);

        let payment = await payments.findOne({ sessionId: sessionId });
        console.log('Payment record found:', !!payment);

        // If payment not in DB yet but Stripe confirms it was paid, manually process it
        if (!payment && session.payment_status === 'paid' && session.metadata) {
            const { packageId, email, packageName } = session.metadata;
            const pkg = await packages.findOne({ id: packageId });

            if (pkg) {
                const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

                console.log('Manually processing payment for session:', sessionId);

                // Store payment record
                await payments.insertOne({
                    sessionId: session.id,
                    transactionId: transactionId,
                    packageId: packageId,
                    packageName: packageName,
                    amount: session.amount_total / 100,
                    email: email,
                    status: 'completed',
                    paymentDate: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                // Update user with new package
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

                console.log('Payment manually processed and stored');

                // Fetch the newly created payment
                payment = await payments.findOne({ sessionId: sessionId });
            }
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
    console.log('Fetching payment history for:', userEmail);

    const paymentHistory = await payments
        .find({ email: userEmail, status: 'completed' })
        .sort({ paymentDate: -1 })
        .toArray();

    console.log(`Found ${paymentHistory.length} payments for ${userEmail}`);

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



/*  ERROR HANDLER */
app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
});

/*  START  */
(async () => {
    await client.connect();
    const db = client.db('assetVerse');
    users = db.collection('users');
    assets = db.collection('assets');
    packages = db.collection('packages');
    payments = db.collection('payments');
    requests = db.collection('requests');

    // Initialize packages if empty
    const packageCount = await packages.countDocuments();
    if (packageCount === 0) {
        await packages.insertMany([
            {
                id: "free",
                name: "Free",
                price: 0,
                employeeLimit: 5,
                features: ["Asset Tracking", "Basic Support"],
                createdAt: new Date()
            },
            {
                id: "basic",
                name: "Basic",
                price: 5,
                employeeLimit: 10,
                features: ["Asset Tracking", "Employee Management", "Basic Support"],
                createdAt: new Date()
            },
            {
                id: "standard",
                name: "Standard",
                price: 8,
                employeeLimit: 20,
                features: ["All Basic features", "Advanced Analytics", "Priority Support"],
                createdAt: new Date()
            },
            {
                id: "premium",
                name: "Premium",
                price: 15,
                employeeLimit: 30,
                features: ["All Standard features", "Custom Branding", "24/7 Support"],
                createdAt: new Date()
            }
        ]);
    }

    // Migration: Update existing HR users to new defaults (5 employee limit, free plan) ONLY if not present
    const result = await users.updateMany(
        { role: 'HR', subscription: { $exists: false } },
        { $set: { packageLimit: 5, subscription: 'free', subscriptionDate: new Date(), updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
        console.log(`Migrated ${result.modifiedCount} users to default subscription.`);
    }

    app.listen(port, () => { });
})();
