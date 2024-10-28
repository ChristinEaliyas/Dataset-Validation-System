const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('view engine', 'ejs');  // Add this line
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB connection setup
const DATABASE_URL = "mongodb://localhost:27017/dataset_validation";
mongoose.connect(DATABASE_URL, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("MongoDB connected"))
    .catch(err => console.error(err));

// Define User schema
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    points: { type: Number, default: 0 },
    created_at: { type: Date, default: Date.now }
});

// Define Record schema
const recordSchema = new mongoose.Schema({
    data_1: { type: String, required: true },
    data_2: { type: String, required: true },
    status: { type: String, enum: ['pending', 'verified_correct', 'verified_incorrect'], default: 'pending' }
});

// Define Validation schema
const validationSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    record_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Record' },
    is_correct: { type: Boolean },
    timestamp: { type: Date, default: Date.now }
});

// Define Verified Record schema
const verifiedRecordSchema = new mongoose.Schema({
    record_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Record', unique: true },
    data_1: { type: String, required: true },
    data_2: { type: String, required: true },
    verified_by: { type: [mongoose.Schema.Types.ObjectId], ref: 'User' }
});

// Define Incorrect Record schema
const incorrectRecordSchema = new mongoose.Schema({
    record_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Record', unique: true },
    data_1: { type: String, required: true },
    data_2: { type: String, required: true },
    incorrect_by: { type: [mongoose.Schema.Types.ObjectId], ref: 'User' }
});

// Models
const User = mongoose.model('User', userSchema);
const Record = mongoose.model('Record', recordSchema);
const Validation = mongoose.model('Validation', validationSchema);
const VerifiedRecord = mongoose.model('VerifiedRecord', verifiedRecordSchema);
const IncorrectRecord = mongoose.model('IncorrectRecord', incorrectRecordSchema);

// Session setup
app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: true
}));

// Registration route
app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    try {
        const newUser = new User({ username, email, password: hashedPassword });
        await newUser.save();
        req.session.user_id = newUser._id; 
        res.redirect('/');
    } catch (error) {
        res.status(400).send("An error occurred: " + error.message);
    }
});

// Login route
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user_id = user._id; // Store user_id in session
        return res.redirect('/');
    } else {
        return res.status(401).send("Invalid email or password");
    }
});

app.post('/', async (req, res) => {
    if (req.method === 'POST') {
        const { record_id, is_correct } = req.body;
        const user_id = req.session.user_id; // Get the user_id from the session

        // Save the validation
        const validation = new Validation({ user_id, record_id, is_correct });
        await validation.save();

        // Retrieve the record to update
        const record = await Record.findById(record_id);
        if (is_correct === "true") {
            
            const correctCount = await Validation.countDocuments({ record_id, is_correct: true });
            if (correctCount > 2) {
                record.status = 'verified_correct';
                await record.save();

                // Check if the record has already been verified to avoid duplicates
                let verifiedRecord = await VerifiedRecord.findOne({ record_id });
                if (!verifiedRecord) {
                    // Create new verified record
                    const user_ids = await Validation.find({ record_id, is_correct: true }).distinct('user_id');
                    verifiedRecord = new VerifiedRecord({
                        record_id,
                        data_1: record.data_1,
                        data_2: record.data_2,
                        verified_by: user_ids
                    });
                    await verifiedRecord.save();

                    // Award points to users
                    await User.updateMany(
                        { _id: { $in: user_ids } },
                        { $inc: { points: 1 } }
                    );
                }
            }
        } else {
            console.log('Called')
            const incorrectCount = await Validation.countDocuments({ record_id, is_correct: false });
            if (incorrectCount > 2) {
                record.status = 'verified_incorrect';
                await record.save();

                // Check if the record has already been marked as incorrect to avoid duplicates
                let incorrectRecord = await IncorrectRecord.findOne({ record_id });
                if (!incorrectRecord) {
                    // Create new incorrect record
                    const user_ids = await Validation.find({ record_id, is_correct: false }).distinct('user_id');
                    incorrectRecord = new IncorrectRecord({
                        record_id,
                        data_1: record.data_1,
                        data_2: record.data_2,
                        incorrect_by: user_ids
                    });
                    await incorrectRecord.save();

                    // Award points to users
                    await User.updateMany(
                        { _id: { $in: user_ids } },
                        { $inc: { points: 1 } }
                    );
                }
            }
        }

        return res.redirect('/'); // Redirect to display a new record
    }
});

app.get('/', async (req, res) => {

    const record = await Record.aggregate([
        { $match: { status: 'pending' } },
        { $sample: { size: 1 } }
    ]);

    if (record.length > 0) {
        res.render('validation', {
            data_1: record[0].data_1,
            data_2: record[0].data_2,
            record_id: record[0]._id,
            session: req.session
        });
    } else {
        res.send("No records found.");
    }
});


app.get('/login', (req, res) => {
    const error = null;
    res.render('login', { error });
})
app.get('/register', (req, res) => {
    const error = null;
    res.render('register', { error });
})
app.get('/logout', (req, res) => {
    req.session.user_id = null;
    res.redirect('/');
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
