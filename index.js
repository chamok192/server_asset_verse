const express = require('express')
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { buildUserDocument, validateUser } = require('./src/utils/userSchema');
const { buildAssetDocument, validateAsset } = require('./src/utils/assetSchema');
const port = process.env.PORT || 3000

app.use(express.json());
app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gtbyi48.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).send({ message: 'Unauthorized access' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).send({ message: 'Invalid token' });
        }
        req.user = decoded;
        next();
    });
};

const verifyHR = async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.user.email });
    
    if (user?.role !== 'HR' && user?.role !== 'Admin') {
        return res.status(403).json({ success: false, error: 'Forbidden access' });
    }
    
    next();
};

let usersCollection;
let assetsCollection;
let requestsCollection;
let paymentsCollection;

async function connectDB() {
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        console.log("Successfully connected to MongoDB!");
        
        const database = client.db("assetVerse");
        usersCollection = database.collection("users");
        assetsCollection = database.collection("assets");
        requestsCollection = database.collection("requests");
        paymentsCollection = database.collection("payments");
    } catch (error) {
        console.error("MongoDB connection error:", error);
    }
}

connectDB();

const ensureDb = async (req, res, next) => {
    if (!usersCollection) {
        return res.status(503).json({ success: false, error: 'Database not ready' });
    }
    next();
};

app.post('/api/auth/login', ensureDb, async (req, res) => {
    try {
        const { email } = req.body;
        const user = await usersCollection.findOne({ email: email });
        
        if (!user) {
            return res.status(404).send({ message: 'User not found' });
        }
        
        const token = jwt.sign(
            { email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.send({ token, user });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.get('/api/users/email/:email', verifyToken, ensureDb, async (req, res) => {
    try {
        const user = await usersCollection.findOne({ email: req.params.email });
        res.send(user);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.post('/api/users', ensureDb, async (req, res) => {
    try {
        const userData = req.body;
        
        const { valid, errors } = validateUser(userData);
        if (!valid) {
            return res.status(400).json({ 
                success: false, 
                errors 
            });
        }

        const existingUser = await usersCollection.findOne({ email: userData.email });
        if (existingUser) {
            return res.status(409).json({ 
                success: false, 
                error: 'User already exists' 
            });
        }

        const userDocument = buildUserDocument(userData);
        const result = await usersCollection.insertOne(userDocument);

        res.json({ 
            success: true, 
            data: result,
            user: userDocument
        });
    } catch (error) {
        console.error('Failed to create user:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/api/users/profile', verifyToken, ensureDb, async (req, res) => {
    try {
        const email = req.user.email;
        const user = await usersCollection.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        res.json({ success: true, data: user });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.patch('/api/users/profile', verifyToken, ensureDb, async (req, res) => {
    try {
        const email = req.user.email;
        const updates = req.body;
        
        delete updates.role;
        delete updates.email;
        delete updates.uid;
        
        updates.updatedAt = new Date();
        
        const result = await usersCollection.findOneAndUpdate(
            { email },
            { $set: updates },
            { returnDocument: 'after' }
        );
        
        if (!result.value) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        res.json({ success: true, data: result.value });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/users', verifyToken, ensureDb, verifyHR, async (req, res) => {
    try {
        const users = await usersCollection.find().toArray();
        res.send(users);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.patch('/api/users/:id/role', verifyToken, ensureDb, verifyHR, async (req, res) => {
    try {
        const { ObjectId } = require('mongodb');
        const result = await usersCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { role: req.body.role } }
        );
        res.send(result);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.post('/api/assets', verifyToken, ensureDb, verifyHR, async (req, res) => {
    try {
        const { name, image, type, quantity } = req.body;
        console.log('Creating asset:', { name, image, type, quantity });
        
        if (!name || !type || quantity === undefined) {
            return res.status(400).json({ 
                success: false, 
                error: 'Name, type, and quantity are required' 
            });
        }

        const asset = {
            name,
            image: image || '',
            type,
            quantity: Number(quantity),
            availableQuantity: Number(quantity),
            hrEmail: req.user.email,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const result = await assetsCollection.insertOne(asset);
        console.log('Asset created:', result.insertedId);

        res.json({ 
            success: true, 
            data: { _id: result.insertedId, ...asset }
        });
    } catch (error) {
        console.error('Asset creation error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/assets', verifyToken, ensureDb, async (req, res) => {
    try {
        const assets = await assetsCollection.find().toArray();
        res.json({ success: true, data: assets });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/assets/:id', verifyToken, ensureDb, async (req, res) => {
    try {
        const asset = await assetsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!asset) {
            return res.status(404).json({ success: false, error: 'Asset not found' });
        }
        res.json({ success: true, data: asset });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.patch('/api/assets/:id', verifyToken, ensureDb, async (req, res) => {
    try {
        const assetData = req.body;
        const updates = {
            name: assetData.name,
            image: assetData.image,
            type: assetData.type,
            quantity: Number(assetData.quantity),
            updatedAt: new Date()
        };

        const result = await assetsCollection.findOneAndUpdate(
            { _id: new ObjectId(req.params.id) },
            { $set: updates },
            { returnDocument: 'after' }
        );

        if (!result.value) {
            return res.status(404).json({ success: false, error: 'Asset not found' });
        }

        res.json({ success: true, data: result.value });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/assets/:id', verifyToken, ensureDb, verifyHR, async (req, res) => {
    try {
        const result = await assetsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, error: 'Asset not found' });
        }

        res.json({ success: true, message: 'Asset deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/requests', verifyToken, ensureDb, verifyHR, async (req, res) => {
    try {
        const requests = await requestsCollection.find().toArray();
        res.json({ success: true, data: requests });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/employees', verifyToken, ensureDb, verifyHR, async (req, res) => {
    try {
        const employees = await usersCollection.find({ role: 'Employee' }).toArray();
        res.json({ success: true, data: employees });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/payments/history', verifyToken, ensureDb, async (req, res) => {
    try {
        const payments = await paymentsCollection
            .find({ userEmail: req.user.email })
            .sort({ createdAt: -1 })
            .toArray();
        res.json({ success: true, data: payments });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.patch('/api/users/make-hr/:email', ensureDb, async (req, res) => {
    try {
        const result = await usersCollection.updateOne(
            { email: req.params.email },
            { $set: { role: 'HR' } }
        );
        res.json({ success: true, message: 'User role updated to HR', result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send('AssetVerse is running')
})

app.listen(port, () => {
    console.log(`AssetVerse app listening on port ${port}`)
})

module.exports = app;
