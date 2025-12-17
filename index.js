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
        req.user = decoded; // { email, role }
// ...existing code...
// Delete a payment transaction by ID
app.delete('/api/payments/:id', verifyToken, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await payments.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 1) {
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, error: 'Payment not found' });
    }
}));
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

        // Log the Stripe success_url for debugging
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

app.post('/api/payments/webhook', express.raw({type: 'application/json'}), asyncHandler(async (req, res) => {
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


/*  ERROR HANDLER */
app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
});

/*  START  */
app.listen(port, () => {});
