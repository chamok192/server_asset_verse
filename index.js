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
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true
}));

const asyncHandler = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = decoded; // { email, role }
        next();
    });
};

/*  DATABASE  */
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gtbyi48.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1 }
});

let users, assets, packages, payments;

(async () => {
    await client.connect();
    const db = client.db('assetVerse');
    users = db.collection('users');
    assets = db.collection('assets');
    packages = db.collection('packages');
    payments = db.collection('payments');
    
    // Initialize packages if empty
    const packageCount = await packages.countDocuments();
    if (packageCount === 0) {
        await packages.insertMany([
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

    // Migration: Update existing HR users to new defaults (5 employee limit, no package)
    const result = await users.updateMany(
        { role: 'HR' },
        { $set: { packageLimit: 5, subscription: null, subscriptionDate: null } }
    );
    if (result.modifiedCount > 0) {
        // Migration complete
    }


})();

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
    res.json(await users.findOne({ email: req.user.email }));
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

app.get('/api/users', verifyToken, verifyHR, asyncHandler(async (req, res) => {
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
    res.json(await assets.find().toArray());
}));

app.get('/api/assets/:id', verifyToken, asyncHandler(async (req, res) => {
    const asset = await assets.findOne({ _id: new ObjectId(req.params.id) });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json(asset);
}));

app.patch('/api/assets/:id', verifyToken, verifyHR, asyncHandler(async (req, res) => {
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
    await assets.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
}));

/*  PAYMENTS  */
app.post('/api/payments/create-intent', verifyToken, asyncHandler(async (req, res) => {
    const { packageId, amount, email, phoneNumber } = req.body;
    if (!packageId || !amount || !email || !phoneNumber) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: 'usd',
            metadata: {
                packageId,
                email,
                phoneNumber
            }
        });
        
        const paymentRecord = {
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            packageId,
            amount,
            email,
            phoneNumber,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        await payments.insertOne(paymentRecord);
        
        res.json({ 
            success: true, 
            data: { 
                clientSecret: paymentIntent.client_secret, 
                paymentIntentId: paymentIntent.id 
            } 
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
}));

app.post('/api/payments/confirm', verifyToken, asyncHandler(async (req, res) => {
    const { paymentIntentId, packageId, amount, phoneNumber } = req.body;
    const userEmail = req.user.email;
    
    if (!paymentIntentId || !packageId || !amount) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status !== 'succeeded') {
            return res.status(400).json({ success: false, error: 'Payment was not successful' });
        }
        
        const pkg = await packages.findOne({ id: packageId });
        if (!pkg) {
            return res.status(404).json({ success: false, error: 'Package not found' });
        }
        
        const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
        
        const paymentRecord = await payments.findOneAndUpdate(
            { paymentIntentId },
            { 
                $set: { 
                    status: 'completed',
                    transactionId: transactionId,
                    phoneNumber: phoneNumber,
                    packageName: pkg.name,
                    paymentDate: new Date(),
                    updatedAt: new Date()
                } 
            },
            { returnDocument: 'after' }
        );
        
        if (!paymentRecord.value) {
            return res.status(404).json({ success: false, error: 'Payment record not found' });
        }
        
        let updateResult = null;
        try {
            updateResult = await users.findOneAndUpdate(
                { email: userEmail },
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
        } catch (err) {
        }
        
        res.json({ 
            success: true, 
            message: 'Payment confirmed and package upgraded',
            data: {
                ...(updateResult?.value || {}),
                transaction: {
                    transactionId,
                    amount,
                    packageName: pkg.name,
                    status: 'completed'
                }
            }
        });
    } catch (error) {
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
        phoneNumber: payment.phoneNumber
    }));
    
    res.json({ success: true, data: formatted });
}));


/*  ERROR HANDLER */
app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
});

/*  START  */
app.listen(port, () => {});
