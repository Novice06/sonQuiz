const express = require("express");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");

const app = express();
app.use(express.json());

// Configuration
const BASE_URL = "https://songquiz.lumitel.bi:8081";
const DATABASE_FILE = "quiz_answers_db.json";

// Variables d'état globales
let isProcessing = false;
let waitingForToken = false;
let waitingForHumanIntervention = false;
let authToken = '';
let scheduledTime = null;
let currentStats = {
    roundsPlayed: 0,
    totalQuestions: 0,
    correctAnswers: 0,
    startTime: null,
    errors: 0
};

// Question en attente d'intervention humaine
let pendingQuestion = null;

// Base de données des réponses
class QuestionDatabase {
    constructor() {
        this.db = {};
        this.loadDatabase();
    }

    async loadDatabase() {
        try {
            const data = await fs.readFile(DATABASE_FILE, 'utf8');
            this.db = JSON.parse(data);
            console.log(`📚 Base de données chargée: ${Object.keys(this.db).length} questions`);
        } catch (error) {
            console.log("📝 Nouvelle base de données créée");
            this.db = {};
        }
    }

    async saveDatabase() {
        try {
            await fs.writeFile(DATABASE_FILE, JSON.stringify(this.db, null, 2));
            console.log(`💾 Base de données sauvegardée (${Object.keys(this.db).length} questions)`);
        } catch (error) {
            console.error(`❌ Erreur sauvegarde DB: ${error.message}`);
        }
    }

    generateKey(title, questionText, options) {
        const optionsStr = options.sort().join("|");
        return `${title}::${questionText}::${optionsStr}`;
    }

    findAnswer(title, questionText, options) {
        const key = this.generateKey(title, questionText, options);
        return this.db[key] || null;
    }

    async saveAnswer(title, questionText, options, correctAnswer) {
        const key = this.generateKey(title, questionText, options);
        this.db[key] = correctAnswer;
        await this.saveDatabase();
        console.log(`💾 Question sauvegardée: '${title}' -> '${correctAnswer}'`);
    }

    normalizeText(text) {
        if (!text) return "";
        return text.toString().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }
}

const questionDB = new QuestionDatabase();

// Headers pour les requêtes
const getHeaders = () => ({
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0'
});

// Routes API
app.get("/", (req, res) => {
    res.json({
        message: "🎵 Quiz Musical Bot API",
        version: "1.0",
        status: getStatusString(),
        endpoints: {
            status: "GET /status - Statut détaillé du bot",
            start: "POST /start-bot - Démarre immédiatement (body: {token, rounds})",
            schedule: "POST /schedule-bot - Programme pour plus tard (body: {token, rounds, time})",
            stop: "POST /stop-bot - Arrête le processus",
            token: "POST /submit-token - Met à jour le token",
            "human-answer": "POST /human-answer - Répond à une question en attente (body: {answer})",
            "pending-question": "GET /pending-question - Récupère la question en attente",
            stats: "GET /stats - Statistiques"
        }
    });
});

app.get("/status", (req, res) => {
    res.json({
        isProcessing,
        waitingForToken,
        waitingForHumanIntervention,
        hasToken: !!authToken,
        scheduledTime,
        currentStats: {
            ...currentStats,
            uptime: currentStats.startTime ? Date.now() - currentStats.startTime : 0
        },
        pendingQuestion: pendingQuestion ? {
            questionText: pendingQuestion.questionText,
            title: pendingQuestion.title,
            options: pendingQuestion.options,
            currentIndex: pendingQuestion.currentIndex
        } : null
    });
});

app.get("/stats", (req, res) => {
    const uptime = currentStats.startTime ? Date.now() - currentStats.startTime : 0;
    const successRate = currentStats.totalQuestions > 0 ? 
        ((currentStats.correctAnswers / currentStats.totalQuestions) * 100).toFixed(2) + '%' : '0%';
    
    res.json({
        roundsPlayed: currentStats.roundsPlayed,
        totalQuestions: currentStats.totalQuestions,
        correctAnswers: currentStats.correctAnswers,
        errors: currentStats.errors,
        successRate,
        uptime: Math.floor(uptime / 1000),
        databaseSize: Object.keys(questionDB.db).length
    });
});

app.get("/pending-question", (req, res) => {
    if (!pendingQuestion) {
        return res.status(404).json({
            success: false,
            error: "Aucune question en attente"
        });
    }

    res.json({
        success: true,
        question: {
            questionText: pendingQuestion.questionText,
            title: pendingQuestion.title,
            options: pendingQuestion.options,
            currentIndex: pendingQuestion.currentIndex,
            roundNumber: pendingQuestion.roundNumber,
            questionNumber: pendingQuestion.questionNumber
        }
    });
});

app.post("/human-answer", async (req, res) => {
    const { answer, saveIfCorrect = true } = req.body;

    if (!pendingQuestion) {
        return res.status(400).json({
            success: false,
            error: "Aucune question en attente"
        });
    }

    if (!answer) {
        return res.status(400).json({
            success: false,
            error: "Réponse requise"
        });
    }

    // Vérifier que la réponse est dans les options
    if (!pendingQuestion.options.includes(answer)) {
        return res.status(400).json({
            success: false,
            error: "Réponse non valide",
            validOptions: pendingQuestion.options
        });
    }

    console.log(`👤 Réponse humaine reçue: '${answer}'`);
    
    // Marquer la réponse comme reçue
    pendingQuestion.humanAnswer = answer;
    pendingQuestion.saveIfCorrect = saveIfCorrect;
    waitingForHumanIntervention = false;

    res.json({
        success: true,
        message: `Réponse '${answer}' acceptée`,
        saveIfCorrect
    });
});

app.post("/start-bot", async (req, res) => {
    const { token, rounds } = req.body;

    if (isProcessing) {
        return res.status(400).json({
            success: false,
            error: "Le bot est déjà en cours d'exécution"
        });
    }

    if (!token || !rounds) {
        return res.status(400).json({
            success: false,
            error: "Token et nombre de rounds requis"
        });
    }

    authToken = token;
    
    try {
        isProcessing = true;
        scheduledTime = null;
        resetStats();
        
        console.log(`🚀 Démarrage immédiat du bot: ${rounds} rounds`);
        
        startQuizBot(rounds).catch(error => {
            console.error("❌ Erreur dans le processus:", error);
            isProcessing = false;
            currentStats.errors++;
        });

        res.json({
            success: true,
            message: `Bot démarré immédiatement pour ${rounds} rounds`
        });
    } catch (error) {
        isProcessing = false;
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post("/schedule-bot", async (req, res) => {
    const { token, rounds, time } = req.body;

    if (isProcessing) {
        return res.status(400).json({
            success: false,
            error: "Le bot est déjà en cours d'exécution"
        });
    }

    if (!token || !rounds || !time) {
        return res.status(400).json({
            success: false,
            error: "Token, rounds et heure requis (format: 'HH:MM' ou timestamp)"
        });
    }

    authToken = token;
    
    try {
        const targetTime = parseScheduleTime(time);
        scheduledTime = targetTime;
        
        console.log(`⏰ Bot programmé pour ${new Date(targetTime).toLocaleString()}`);
        
        // Démarrer la surveillance du planning
        scheduleQuizBot(rounds, targetTime);

        res.json({
            success: true,
            message: `Bot programmé pour ${new Date(targetTime).toLocaleString()}`,
            scheduledTime: targetTime,
            rounds
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post("/stop-bot", (req, res) => {
    if (!isProcessing && !scheduledTime) {
        return res.status(400).json({
            success: false,
            error: "Aucun processus en cours"
        });
    }

    isProcessing = false;
    scheduledTime = null;
    pendingQuestion = null;
    waitingForHumanIntervention = false;
    
    console.log("🛑 Arrêt du bot demandé");
    
    res.json({
        success: true,
        message: "Bot arrêté",
        finalStats: currentStats
    });
});

app.post("/submit-token", (req, res) => {
    const { token } = req.body;
    
    if (!token) {
        return res.status(400).json({
            success: false,
            error: "Token requis"
        });
    }

    authToken = token;
    waitingForToken = false;
    
    console.log("🔑 Token mis à jour");
    
    res.json({
        success: true,
        message: "Token configuré avec succès"
    });
});

// Fonctions utilitaires
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function resetStats() {
    currentStats = {
        roundsPlayed: 0,
        totalQuestions: 0,
        correctAnswers: 0,
        startTime: Date.now(),
        errors: 0
    };
}

function getStatusString() {
    if (isProcessing) return "RUNNING";
    if (waitingForHumanIntervention) return "WAITING_FOR_HUMAN";
    if (waitingForToken) return "WAITING_FOR_TOKEN";
    if (scheduledTime) return "SCHEDULED";
    return "READY";
}

function parseScheduleTime(timeStr) {
    const now = new Date();
    
    // Si c'est un timestamp
    if (!isNaN(timeStr)) {
        const timestamp = parseInt(timeStr);
        if (timestamp > Date.now()) {
            return timestamp;
        }
        throw new Error("Timestamp dans le passé");
    }
    
    // Si c'est au format HH:MM
    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) {
        throw new Error("Format invalide. Utilisez HH:MM ou timestamp");
    }
    
    const [, hours, minutes] = timeMatch;
    const targetTime = new Date();
    targetTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    // Si l'heure est déjà passée aujourd'hui, programmer pour demain
    if (targetTime <= now) {
        targetTime.setDate(targetTime.getDate() + 1);
    }
    
    return targetTime.getTime();
}

// Fonctions API du quiz
async function getUserInfo() {
    try {
        const response = await axios.get(`${BASE_URL}/users/me`, {
            headers: getHeaders()
        });
        return response.data;
    } catch (error) {
        console.error(`❌ Erreur getUserInfo: ${error.message}`);
        throw error;
    }
}

async function fetchQuestion() {
    try {
        const response = await axios.get(`${BASE_URL}/questions/fetch`, {
            headers: getHeaders()
        });
        return response.data;
    } catch (error) {
        console.error(`❌ Erreur fetchQuestion: ${error.message}`);
        throw error;
    }
}

async function submitAnswer(answer) {
    try {
        const response = await axios.post(`${BASE_URL}/answers/submit`, {
            answer: answer,
            isBoost: true
        }, {
            headers: getHeaders()
        });
        return response.data;
    } catch (error) {
        console.error(`❌ Erreur submitAnswer: ${error.message}`);
        throw error;
    }
}

// Algorithmes de résolution (portés du Python)
function normalizeText(text) {
    if (!text) return "";
    return text.toString().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').strip();
}

function strstrMatch(title, options) {
    const titleLower = title.toLowerCase();
    
    for (const option of options) {
        const optionLower = option.toLowerCase();
        if (titleLower.includes(optionLower)) {
            console.log(`✅ Correspondance strstr: '${option}' dans '${title}'`);
            return option;
        }
    }
    return null;
}

function artistTitleAnalysis(title, options, questionText) {
    const questionLower = questionText.toLowerCase();
    
    const isArtistQuestion = ['ninde', 'yaririmvye', 'artist', 'singer', 'chanteur']
        .some(word => questionLower.includes(word));
    const isTitleQuestion = ['zina', 'ndirimbo', 'title', 'titre', 'song']
        .some(word => questionLower.includes(word));
    
    if (title.includes(' - ')) {
        const [artistPart, titlePart] = title.split(' - ', 2);
        
        if (isArtistQuestion) {
            console.log(`🎤 Question artiste détectée: '${artistPart}'`);
            for (const option of options) {
                if (normalizeText(option) === normalizeText(artistPart)) {
                    console.log(`✅ Artiste trouvé: '${option}'`);
                    return option;
                }
            }
        }
        
        if (isTitleQuestion) {
            console.log(`🎵 Question titre détectée: '${titlePart}'`);
            for (const option of options) {
                if (normalizeText(option) === normalizeText(titlePart)) {
                    console.log(`✅ Titre trouvé: '${option}'`);
                    return option;
                }
            }
        }
    }
    
    return null;
}

function findBestAnswer(questionText, title, options) {
    console.log(`🎵 Titre: '${title}'`);
    console.log(`🎯 Options: ${JSON.stringify(options)}`);
    
    // 1. Base de données
    const dbAnswer = questionDB.findAnswer(title, questionText, options);
    if (dbAnswer && options.includes(dbAnswer)) {
        console.log(`📚 Réponse DB: '${dbAnswer}'`);
        return { answer: dbAnswer, source: "database" };
    }
    
    // 2. Correspondance strstr
    const strstrResult = strstrMatch(title, options);
    if (strstrResult) {
        return { answer: strstrResult, source: "strstr" };
    }
    
    // 3. Analyse artiste/titre
    const artistTitleResult = artistTitleAnalysis(title, options, questionText);
    if (artistTitleResult) {
        return { answer: artistTitleResult, source: "artist_title" };
    }
    
    // 4. Intervention humaine requise
    console.log("🚨 Intervention humaine requise");
    return { answer: null, source: "human_needed" };
}

// Fonctions principales du bot
async function waitForHumanAnswer(questionData, roundNum, questionNum) {
    pendingQuestion = {
        ...questionData,
        roundNumber: roundNum,
        questionNumber: questionNum,
        humanAnswer: null,
        saveIfCorrect: true
    };
    
    waitingForHumanIntervention = true;
    console.log("⏳ En attente de l'intervention humaine...");
    console.log("📡 Utilisez POST /human-answer pour répondre");
    
    // Attendre la réponse
    while (waitingForHumanIntervention && isProcessing) {
        await sleep(1000);
    }
    
    if (!isProcessing) {
        return null;
    }
    
    const result = {
        answer: pendingQuestion.humanAnswer,
        source: "human",
        saveIfCorrect: pendingQuestion.saveIfCorrect
    };
    
    pendingQuestion = null;
    return result;
}

async function playRound(roundNum) {
    console.log(`\n🎮 === MANCHE ${roundNum} ===`);
    let correctAnswers = 0;
    
    for (let questionNum = 1; questionNum <= 10; questionNum++) {
        if (!isProcessing) break;
        
        console.log(`\n📝 Question ${questionNum}/10`);
        
        try {
            // Récupérer la question
            const questionData = await fetchQuestion();
            const { questionText, options, songInfo, currentIndex } = questionData;
            const title = songInfo?.title || '';
            
            console.log(`❓ ${questionText}`);
            console.log(`📍 Index: ${currentIndex}`);
            
            currentStats.totalQuestions++;
            
            // Trouver la réponse
            let result = findBestAnswer(questionText, title, options);
            
            // Si intervention humaine nécessaire
            if (!result.answer) {
                result = await waitForHumanAnswer(questionData, roundNum, questionNum);
                if (!result) {
                    console.log("❌ Processus arrêté pendant l'attente");
                    return false;
                }
            }
            
            // Soumettre la réponse
            console.log(`📤 Soumission: '${result.answer}'`);
            const submitResult = await submitAnswer(result.answer);
            
            if (submitResult?.correct) {
                console.log(`✅ Correct! Status: ${submitResult.status}`);
                correctAnswers++;
                currentStats.correctAnswers++;
                
                // Sauvegarder si c'est une réponse humaine correcte
                if (result.source === "human" && result.saveIfCorrect) {
                    await questionDB.saveAnswer(title, questionText, options, result.answer);
                    console.log("💾 Réponse humaine sauvegardée!");
                }
            } else {
                console.log(`❌ Incorrect! Status: ${submitResult?.status || 'unknown'}`);
            }
            
            await sleep(1000); // Pause entre questions
            
            if (submitResult?.status === "completed") {
                console.log(`🏁 Manche terminée! Score: ${correctAnswers}/10`);
                break;
            }
            
        } catch (error) {
            console.error(`❌ Erreur question ${questionNum}: ${error.message}`);
            currentStats.errors++;
            await sleep(2000);
        }
    }
    
    currentStats.roundsPlayed++;
    return true;
}

async function startQuizBot(roundsToPlay) {
    console.log(`🚀 Démarrage du bot: ${roundsToPlay} rounds`);
    
    try {
        // Vérifier les tours disponibles
        const userInfo = await getUserInfo();
        const availableTurns = userInfo?.playTimes || 0;
        
        console.log(`👤 Utilisateur: ${userInfo?.name || 'Inconnu'}`);
        console.log(`🎯 Tours disponibles: ${availableTurns}`);
        console.log(`🎮 Tours demandés: ${roundsToPlay}`);
        
        if (availableTurns < roundsToPlay) {
            console.log(`❌ Tours insuffisants! Manquants: ${roundsToPlay - availableTurns}`);
            isProcessing = false;
            return;
        }
        
        // Jouer les rounds
        for (let round = 1; round <= roundsToPlay && isProcessing; round++) {
            const success = await playRound(round);
            if (!success) {
                console.log(`❌ Échec round ${round}`);
                break;
            }
            
            // Pause entre les rounds
            if (round < roundsToPlay && isProcessing) {
                console.log("⏳ Pause 2s avant le prochain round...");
                await sleep(2000);
            }
        }
        
    } catch (error) {
        console.error(`❌ Erreur générale: ${error.message}`);
        currentStats.errors++;
    } finally {
        isProcessing = false;
        console.log("🏁 Bot terminé");
        console.log(`📊 Stats: ${currentStats.roundsPlayed}/${roundsToPlay} rounds, ${currentStats.correctAnswers}/${currentStats.totalQuestions} questions`);
    }
}

async function scheduleQuizBot(rounds, targetTime) {
    console.log(`⏰ Surveillance du planning: ${new Date(targetTime).toLocaleString()}`);
    
    const checkInterval = setInterval(() => {
        if (!scheduledTime) {
            clearInterval(checkInterval);
            return;
        }
        
        if (Date.now() >= targetTime) {
            clearInterval(checkInterval);
            console.log("🚀 Démarrage programmé!");
            
            isProcessing = true;
            scheduledTime = null;
            resetStats();
            
            startQuizBot(rounds).catch(error => {
                console.error("❌ Erreur programmée:", error);
                isProcessing = false;
            });
        }
    }, 1000);
}

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
    console.log('\n🛑 Arrêt par signal');
    isProcessing = false;
    scheduledTime = null;
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Arrêt par SIGTERM');
    isProcessing = false;
    scheduledTime = null;
    process.exit(0);
});

// Démarrage du serveur
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Quiz Musical Bot API running on port ${PORT}`);
    console.log(`\n📱 Endpoints principaux:`);
    console.log(`   POST /start-bot - Démarre immédiatement`);
    console.log(`   POST /schedule-bot - Programme pour plus tard`);
    console.log(`   POST /human-answer - Répond aux questions`);
    console.log(`   GET /status - Statut et question en attente`);
    console.log(`\n💡 Usage typique:`);
    console.log(`   1. POST /start-bot {token: "xxx", rounds: 5}`);
    console.log(`   2. Surveiller GET /status pour les questions`);
    console.log(`   3. Répondre avec POST /human-answer {answer: "..."}`);
    console.log(`\n⏰ Scheduling:`);
    console.log(`   POST /schedule-bot {token: "xxx", rounds: 5, time: "22:00"}`);
    console.log(`   (time peut être "HH:MM" ou timestamp Unix)`);
});