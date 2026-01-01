const { ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class PaymentController {
    constructor(collections) {
        this.paymentCollection = collections.paymentCollection;
        this.userCollection = collections.userCollection;
        this.packageCollection = collections.packageCollection;
    }

    async createCheckoutSession(req, res) {
        try {
            const packageInfo = req.body;
            const pkg = await this.packageCollection.findOne({ id: packageInfo.packageId });
            if (!pkg) return res.status(404).send({ error: 'Package not found' });

            const amount = parseInt(pkg.price) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            unit_amount: amount,
                            product_data: {
                                name: `Upgrade to ${pkg.name}`
                            }
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                metadata: {
                    packageId: packageInfo.packageId,
                    email: packageInfo.email
                },
                customer_email: packageInfo.email,
                success_url: `${process.env.FRONTEND_URL}/hr/payments?payment=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.FRONTEND_URL}/hr/upgrade`,
            });

            res.send({ url: session.url });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async handlePaymentSuccess(req, res) {
        try {
            const sessionId = req.query.session_id;
            if (!sessionId) return res.send({ success: false, error: 'No session ID provided' });

            console.log('Processing payment for session:', sessionId);

            const session = await stripe.checkout.sessions.retrieve(sessionId);
            console.log('Session retrieved:', { id: session.id, payment_status: session.payment_status, payment_intent: session.payment_intent });

            const transactionId = session.payment_intent || session.id;
            const query = { transactionId: transactionId };

            const paymentExist = await this.paymentCollection.findOne(query);
            if (paymentExist) {
                console.log('Payment already exists:', paymentExist._id);
                return res.send({
                    success: true,
                    data: {
                        payment: paymentExist,
                        session: {
                            status: session.status,
                            paymentStatus: session.payment_status
                        }
                    }
                });
            }

            // If not processed, process it now
            const packageId = session.metadata.packageId;
            const email = session.metadata.email;

            console.log('Processing new payment:', { packageId, email, payment_status: session.payment_status });

            if (session.payment_status === 'paid') {
                const pkg = await this.packageCollection.findOne({ id: packageId });
                if (!pkg) {
                    console.error('Package not found:', packageId);
                    return res.send({ success: false, error: 'Package information not found' });
                }

                const userQuery = { email: email };
                const update = {
                    $set: {
                        subscription: packageId,
                        packageLimit: pkg.employeeLimit,
                        subscriptionDate: new Date()
                    }
                };

                console.log('Updating user:', email, 'with package:', packageId);
                await this.userCollection.updateOne(userQuery, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: email.toLowerCase(),
                    packageId: packageId,
                    packageName: pkg.name,
                    transactionId: transactionId,
                    paymentStatus: session.payment_status,
                    paidAt: new Date()
                };

                console.log('Saving payment:', payment);
                await this.paymentCollection.insertOne(payment);

                return res.send({
                    success: true,
                    data: {
                        payment: payment,
                        session: {
                            status: session.status,
                            paymentStatus: session.payment_status
                        }
                    }
                });
            }
            console.log('Payment not completed, status:', session.payment_status);
            return res.send({ success: false, error: 'Payment not completed' });
        } catch (error) {
            console.error('Error in payment-success:', error);
            res.send({ success: false, error: error.message });
        }
    }

    async getPayments(req, res) {
        try {
            const email = req.query.email;
            const query = {};

            if (email) {
                query.customerEmail = email;

                if (email !== req.user.email) {
                    return res.status(403).send({ message: 'forbidden access' });
                }
            }
            const cursor = this.paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getPaymentHistory(req, res) {
        try {
            const userEmail = req.user.email;

            const paymentHistory = await this.paymentCollection
                .find({ customerEmail: userEmail.toLowerCase() })
                .sort({ paidAt: -1 })
                .toArray();

            const formatted = paymentHistory.map(payment => ({
                _id: payment._id,
                transactionId: payment.transactionId,
                amount: payment.amount,
                packageName: payment.packageName,
                paymentDate: payment.paidAt,
                status: 'completed',
                email: payment.customerEmail
            }));

            res.json({ success: true, data: formatted });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async deletePayment(req, res) {
        try {
            const id = req.params.id;
            const oid = new ObjectId(id);
            const result = await this.paymentCollection.deleteOne({ _id: oid });
            if (result.deletedCount === 1) {
                return res.json({ success: true });
            }
            return res.status(404).json({ success: false, error: 'Payment not found' });
        } catch (err) {
            return res.status(400).json({ success: false, error: 'Invalid payment ID' });
        }
    }
}

module.exports = PaymentController;