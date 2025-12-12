const express = require('express')
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');
const port = process.env.PORT || 3000

//middleware
app.use(express.json());
app.use(cors());
app.use(cookieParser());


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
    const email = req.user.email;
    const database = client.db("assetVerse");
    const usersCollection = database.collection("users");
    
    const user = await usersCollection.findOne({ email: email });
    
    if (user?.role !== 'HR' && user?.role !== 'Admin') {
        return res.status(403).send({ message: 'Forbidden access' });
    }
    
    next();
};


async function run() {
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        console.log("Successfully connected to MongoDB!");

        const database = client.db("assetVerse");
        const usersCollection = database.collection("users");

        app.post('/api/auth/login', async (req, res) => {
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

        app.get('/api/users/email/:email', verifyToken, async (req, res) => {
            try {
                const user = await usersCollection.findOne({ email: req.params.email });
                res.send(user);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/api/users', async (req, res) => {
            try {
                const result = await usersCollection.insertOne(req.body);
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/users', verifyToken, verifyHR, async (req, res) => {
            try {
                const users = await usersCollection.find().toArray();
                res.send(users);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.patch('/api/users/:id/role', verifyToken, verifyHR, async (req, res) => {
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

    } finally {
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('AssetVerse is running')
})

app.listen(port, () => {
    console.log(`AssetVerse app listening on port ${port}`)
})
