# AssetVerse - Server

Backend API server for AssetVerse corporate asset management system. Built with Express.js and MongoDB.

## Live URL

**API Server:** Deployed on Vercel  
**Client:** [https://server-asset-verse.vercel.app/](https://server-asset-verse.vercel.app/)

## Key Features

- **RESTful API** - Clean API design for all CRUD operations
- **JWT Authentication** - Secure token-based authentication
- **Role-Based Authorization** - HR Manager and Employee role verification
- **MongoDB Integration** - Efficient data storage with MongoDB Atlas
- **Stripe Payments** - Secure payment processing for subscription upgrades
- **Firebase Admin** - Server-side Firebase token verification
- **CORS Enabled** - Cross-origin resource sharing for frontend integration

## NPM Packages Used

### Dependencies
| Package | Version | Description |
|---------|---------|-------------|
| `express` | ^5.2.1 | Web framework |
| `mongodb` | ^7.0.0 | MongoDB driver |
| `cors` | ^2.8.5 | CORS middleware |
| `dotenv` | ^17.2.3 | Environment variables |
| `jsonwebtoken` | ^9.0.3 | JWT authentication |
| `bcryptjs` | ^3.0.3 | Password hashing |
| `stripe` | ^20.0.0 | Stripe payment processing |
| `firebase-admin` | ^13.6.0 | Firebase Admin SDK |
| `cookie-parser` | ^1.4.7 | Cookie parsing middleware |

### Dev Dependencies
| Package | Version | Description |
|---------|---------|-------------|
| `nodemon` | ^3.1.11 | Development auto-reload |

##  Setup Instructions

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn
- MongoDB Atlas account
- Stripe account
- Firebase project (for Admin SDK)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/chamok192/server_asset_verse

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create environment file**
   ```bash
   cp .env.example .env
   ```

4. **Start development server**
   ```bash
   npm run dev
   ```

5. **Start production server**
   ```bash
   npm start
   ```

##  Environment Variables Configuration

Create a `.env` file in the root directory with the following variables:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# MongoDB Configuration
DB_USER=your_mongodb_username
DB_PASSWORD=your_mongodb_password

# JWT Configuration
JWT_SECRET=your_super_secret_jwt_key_here

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key

# Frontend URL (for Stripe redirects)
FRONTEND_URL=http://localhost:5173

# Firebase Admin SDK (Base64 encoded service account JSON)
FB_SERVICE_KEY=base64_encoded_firebase_service_account_json
```

### my env file data ##
DB_USER=asset_verse_user
DB_PASSWORD=Ipd0peN6a5QjhCGx
JWT_SECRET=supersecretkey123456789
STRIPE_SECRET_KEY=git not accept sk key
FRONTEND_URL=http://localhost:5173
firebase service key can not add because git do not accepting

####

## Deployment

### Vercel Deployment

1. Install Vercel CLI: `npm i -g vercel`
2. Run: `vercel --prod`
3. Set environment variables in Vercel dashboard

The `vercel.json` is already configured for serverless deployment.
