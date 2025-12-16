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

let users, assets, packages;

(async () => {
    await client.connect();
    const db = client.db('assetVerse');
    users = db.collection('users');
    assets = db.collection('assets');
    packages = db.collection('packages');
    
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
        console.log('Packages initialized');
    }
    console.log('MongoDB Connected');
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
    const allowed = ['name', 'phone', 'address', 'profileImage', 'dateOfBirth'];
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
            profileImage: user.profileImage
        }
    });
}));

/* PACKAGES */
app.get('/api/packages', asyncHandler(async (req, res) => {
    const allPackages = await packages.find().sort({ price: 1 }).toArray();
    res.json({ success: true, data: allPackages });
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

/*  ERROR HANDLER */
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
});

/*  START  */
app.listen(port, () => console.log(`AssetVerse running on port ${port}`));
