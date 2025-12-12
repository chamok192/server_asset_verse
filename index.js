const express = require('express')
const app = express();
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');
const port = process.env.PORT || 3000

//middleware
app.use(express.json());
app.use(cors());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gtbyi48.mongodb.net/?appName=Cluster0`;


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});


async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        // Database collections
        const database = client.db("assetVerse");
        const usersCollection = database.collection("users");

        // Get user by email
        app.get('/api/users/email/:email', async (req, res) => {
            try {
                const user = await usersCollection.findOne({ email: req.params.email });
                res.send(user);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // Create new user
        app.post('/api/users', async (req, res) => {
            try {
                const result = await usersCollection.insertOne(req.body);
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

    } finally {
        // Ensures that the client will close when you finish/error
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
