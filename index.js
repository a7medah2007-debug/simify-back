const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// هنا بنقول للسيرفر يربط بفايربيز ببيانات مخفية للأمان
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
    });
}

const db = admin.firestore();

// دي الوظيفة اللي بتطلب الرقم من HeroSMS
app.get('/api/get-number', async (req, res) => {
    const { service, country, uid, price } = req.query;
    const HERO_KEY = process.env.HERO_API_KEY;
    const HERO_URL = "https://hero-sms.com/stubs/handler_api.php";

    try {
        const userRef = db.collection('users').doc(uid);
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=getNumber&service=${service}&country=${country}`);
        
        if (response.data.includes('ACCESS_NUMBER')) {
            const [_, id, number] = response.data.split(':');
            // خصم الرصيد
            await userRef.update({ balance: admin.firestore.FieldValue.increment(-parseFloat(price)) });
            res.json({ success: true, id, number });
        } else {
            res.json({ success: false, message: 'الأرقام خلصانة حالياً' });
        }
    } catch (err) {
        res.status(500).json({ error: 'حصلت مشكلة في السيرفر' });
    }
});

module.exports = app;
