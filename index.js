const express = require('express')
const cors = require('cors');
const app = express();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const AuthController = require('./controllers/AuthController');
const AssetController = require('./controllers/AssetController');
const EmployeeController = require('./controllers/EmployeeController');
const RequestController = require('./controllers/RequestController');
const PaymentController = require('./controllers/PaymentController');

const jwtSecret = process.env.JWT_SECRET || 'your_default_secret_here';

const admin = require("firebase-admin");

// Initialize Firebase admin only when FB_SERVICE_KEY is provided and valid
let serviceAccount;
try {
    if (process.env.FB_SERVICE_KEY) {
        const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase admin initialized');
        }
    } else {
        console.warn('FB_SERVICE_KEY not set - skipping Firebase admin initialization');
    }
} catch (err) {
    console.error('Failed to initialize Firebase admin:', err);
}

// middleware
app.use(express.json());
app.use(cors());

const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, jwtSecret, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        // Normalize role to lowercase to avoid case-sensitivity issues
        req.user = { ...decoded, role: String(decoded.role || '').toLowerCase() };
        next();
    });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gtbyi48.mongodb.net/?retryWrites=true&w=majority`;

// Global collections object to be populated after DB connection
const collections = {
    userCollection: null,
    assetCollection: null,
    packageCollection: null,
    paymentCollection: null,
    requestCollection: null,
    employeeAffiliationCollection: null,
    assignedAssetCollection: null
};

// Instantiate controllers once
const authController = new AuthController(collections);
const assetController = new AssetController(collections);
const employeeController = new EmployeeController(collections);
const requestController = new RequestController(collections);
const paymentController = new PaymentController(collections);

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// Separate DB connection logic for serverless re-use
let cachedClient = null;
async function connectDB() {
    if (collections.userCollection) return; // Already connected

    try {
        await client.connect();
        console.log("Connected to MongoDB");

        const db = client.db('assetVerse');
        collections.userCollection = db.collection('users');
        collections.assetCollection = db.collection('assets');
        collections.packageCollection = db.collection('packages');
        collections.paymentCollection = db.collection('payments');
        collections.requestCollection = db.collection('requests');
        collections.employeeAffiliationCollection = db.collection('employeeAffiliations');
        collections.assignedAssetCollection = db.collection('assignedAssets');

        // Update controller instances with the real collections
        [authController, assetController, employeeController, requestController, paymentController].forEach(c => {
            Object.keys(collections).forEach(key => {
                c[key] = collections[key];
            });
        });

        // Initialize packages if empty
        const packageCount = await collections.packageCollection.countDocuments();
        if (packageCount === 0) {
            await collections.packageCollection.insertMany([
                {
                    id: "basic",
                    name: "Basic",
                    price: 5,
                    employeeLimit: 5,
                    features: ["Asset Tracking", "Employee Management", "Basic Support"],
                    createdAt: new Date()
                },
                {
                    id: "standard",
                    name: "Standard",
                    price: 8,
                    employeeLimit: 10,
                    features: ["All Basic features", "Advanced Analytics", "Priority Support"],
                    createdAt: new Date()
                },
                {
                    id: "premium",
                    name: "Premium",
                    price: 15,
                    employeeLimit: 20,
                    features: ["All Standard features", "Custom Branding", "24/7 Support"],
                    createdAt: new Date()
                }
            ]);
        }
    } catch (error) {
        console.error("MongoDB connection error:", error);
    }
}

// Ensure DB is connected before processing requests
const ensureDb = async (req, res, next) => {
    if (!collections.userCollection) {
        await connectDB();
    }
    if (!collections.userCollection) {
        return res.status(503).json({ error: 'Database connection failed' });
    }
    next();
};

const verifyAdmin = async (req, res, next) => {
    const email = req.user.email;
    const user = await collections.userCollection.findOne({ email });
    if (!user || String(user.role || '').toLowerCase() !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
    }
    next();
}

const verifyHR = (req, res, next) => {
    const role = String(req.user.role || '').toLowerCase();
    if (!['hr', 'admin'].includes(role)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

// All Routes Registered Synchronously for Vercel
app.get('/', (req, res) => res.send('AssetVerse Server is running!'))
app.get('/favicon.ico', (req, res) => res.status(204).end());

// auth routes
app.post('/api/auth/login', ensureDb, (req, res) => authController.login(req, res));
app.get('/api/users/profile', verifyToken, ensureDb, (req, res) => authController.getProfile(req, res));
app.patch('/api/users/profile', verifyToken, ensureDb, (req, res) => authController.updateProfile(req, res));
app.post('/api/users', ensureDb, (req, res) => authController.register(req, res));
app.get('/api/users/check-email/:email', ensureDb, (req, res) => authController.checkEmail(req, res));
app.get('/api/users/email/:email', ensureDb, (req, res) => authController.getUserByEmail(req, res));
app.get('/api/users/limit-check', verifyToken, ensureDb, (req, res) => authController.checkLimit(req, res));
app.get('/api/employees', verifyToken, ensureDb, (req, res) => employeeController.getEmployees(req, res));
app.delete('/api/employees/:id', verifyToken, ensureDb, (req, res) => employeeController.removeEmployee(req, res));
app.patch('/users/:id/role', verifyToken, verifyAdmin, ensureDb, (req, res) => authController.updateRole(req, res));

// assets related apis
app.get('/api/assets', verifyToken, ensureDb, (req, res) => assetController.getAssets(req, res));
app.get('/api/assets/:id', verifyToken, ensureDb, (req, res) => assetController.getAssetById(req, res));
app.post('/api/assets/:assetId/assign', verifyToken, verifyHR, ensureDb, (req, res) => assetController.assignAsset(req, res));
app.post('/api/assets', verifyToken, verifyHR, ensureDb, (req, res) => assetController.createAsset(req, res));
app.patch('/api/assets/:id', verifyToken, ensureDb, (req, res) => assetController.updateAsset(req, res));
app.delete('/api/assets/:id', verifyToken, ensureDb, (req, res) => assetController.deleteAsset(req, res));

// packages related apis
app.get('/api/packages', ensureDb, async (req, res) => {
    try {
        const cursor = collections.packageCollection.find({}).sort({ createdAt: -1 });
        const result = await cursor.toArray();
        res.send(result);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/hr/analytics', verifyToken, verifyHR, ensureDb, (req, res) => assetController.getAnalytics(req, res));

// Debug endpoint to inspect authenticated user and DB connection
app.get('/api/debug/me', verifyToken, ensureDb, (req, res) => {
    res.json({ user: req.user, dbConnected: !!collections.userCollection });
});

// requests management
app.post('/api/requests', verifyToken, ensureDb, (req, res) => requestController.createRequest(req, res));
app.get('/api/requests', verifyToken, verifyHR, ensureDb, (req, res) => requestController.getRequests(req, res));
app.patch('/api/requests/:id', verifyToken, verifyHR, ensureDb, (req, res) => requestController.processRequest(req, res));

// Get assigned assets for employee
app.get('/api/employee-assets', verifyToken, ensureDb, (req, res) => employeeController.getEmployeeAssets(req, res));
app.post('/api/employee-assets/:id/return', verifyToken, ensureDb, (req, res) => employeeController.returnAsset(req, res));
app.delete('/api/employee-assets/:id', verifyToken, ensureDb, (req, res) => employeeController.deleteEmployeeAsset(req, res));
app.get('/api/my-team', verifyToken, ensureDb, (req, res) => employeeController.getMyTeam(req, res));

// payment related apis
app.post('/payment-checkout-session', ensureDb, (req, res) => paymentController.createCheckoutSession(req, res));
app.get('/payment-success', ensureDb, (req, res) => paymentController.handlePaymentSuccess(req, res));
app.get('/payments', verifyToken, ensureDb, (req, res) => paymentController.getPayments(req, res));
app.get('/api/payments/history', verifyToken, ensureDb, (req, res) => paymentController.getPaymentHistory(req, res));
app.delete('/api/payments/:id', verifyToken, ensureDb, (req, res) => paymentController.deletePayment(req, res));

// Start server for local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server listening on port ${port}`)
    });
}

// Always try to connect on startup for warm lambdas
connectDB();

module.exports = app;
