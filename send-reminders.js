import admin from "firebase-admin";

const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

const TASK_ICONS = {
    "Food": "🥣",
    "Fresh Water": "💧",
    "Morning Walk": "🚶",
    "Evening Walk": "🌆",
    "Medicine": "💊",
    "Grooming": "🧼"
};

/* =========================
   DEFAULT REMINDER TIMES
========================= */

const DEFAULT_REMINDER_TIMES = {
    "Food": "08:00",
    "Fresh Water": "09:00",
    "Morning Walk": "07:30",
    "Evening Walk": "17:00",
    "Medicine": "19:00"
};

/* =========================
   INDIA TIME
========================= */

function getIndiaTime() {
    const now = new Date();

    const parts = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).formatToParts(now);

    const get = (type) =>
        parts.find((p) => p.type === type)?.value;

    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        time: `${get("hour")}:${get("minute")}`
    };
}

function minutesFromTime(time) {
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
}

/* =========================
   FAMILY NOTIFICATION TOKENS
========================= */

async function getFamilyTokens(familyId) {
    const membersSnap = await db
        .collection("families")
        .doc(familyId)
        .collection("members")
        .get();

    const tokens = [];

    for (const member of membersSnap.docs) {
        const userSnap = await db
            .collection("users")
            .doc(member.id)
            .get();

        if (!userSnap.exists) {
            continue;
        }

        const user = userSnap.data();

        if (
            user.notificationsEnabled === true &&
            user.fcmToken
        ) {
            tokens.push(user.fcmToken);
        }
    }

    return [...new Set(tokens)];
}

/* =========================
   SEND NOTIFICATION
========================= */

async function sendNotification(
    tokens,
    title,
    body,
    tag
) {
    if (!tokens.length) {
        console.log("No notification tokens found.");
        return;
    }

    const message = {
        tokens: tokens,

        notification: {
            title: title,
            body: body
        },

        data: {
            tag: tag
        },

        webpush: {
            notification: {
                title: title,
                body: body,
                tag: tag
            }
        }
    };

    const response =
        await messaging.sendEachForMulticast(message);

    console.log(
        `Notification sent: ${response.successCount} successful, ${response.failureCount} failed`
    );
}

/* =========================
   PROCESS ONE PET
========================= */

async function processPet(
    familyId,
    petId,
    petName
) {
    console.log(
        `Processing pet: ${petName}`
    );

    const reminderRef = db
        .collection("families")
        .doc(familyId)
        .collection("pets")
        .doc(petId)
        .collection("reminders")
        .doc("reminders");

    const reminderSnap =
        await reminderRef.get();

    const reminders =
        reminderSnap.exists
            ? reminderSnap.data()
            : {};

    const today = getIndiaTime();

    const nowMinutes =
        minutesFromTime(today.time);

    console.log(
        `India time: ${today.date} ${today.time}`
    );

    /* =========================
       TODAY'S COMPLETED TASKS
    ========================= */

    const tasksRef = db
        .collection("families")
        .doc(familyId)
        .collection("pets")
        .doc(petId)
        .collection("days")
        .doc(today.date)
        .collection("tasks");

    const tasksSnap =
        await tasksRef.get();

    const completed = {};

    tasksSnap.forEach((taskDoc) => {
        const data = taskDoc.data();

        if (data.completed === true) {
            completed[data.taskName] = true;
        }
    });

    /* =========================
       FAMILY TOKENS
    ========================= */

    const tokens =
        await getFamilyTokens(familyId);

    if (!tokens.length) {
        console.log(
            `No enabled notification tokens for family ${familyId}`
        );
        return;
    }

    /* =========================
       CHECK DEFAULT + CUSTOM TIMES
    ========================= */

    const taskNames = Object.keys(
        DEFAULT_REMINDER_TIMES
    );

    for (const taskName of taskNames) {

        /*
         * If user has saved a custom reminder,
         * use that.
         *
         * Otherwise use the default time.
         */

        let reminderTime =
            reminders[taskName];

        if (
            typeof reminderTime !== "string" ||
            !/^\d{2}:\d{2}$/.test(reminderTime)
        ) {
            reminderTime =
                DEFAULT_REMINDER_TIMES[taskName];
        }

        /* Completed = no notification */

        if (completed[taskName]) {
            console.log(
                `${taskName}: already completed`
            );
            continue;
        }

        const dueMinutes =
            minutesFromTime(reminderTime);

        const minutesLate =
            nowMinutes - dueMinutes;

        let notificationType = "";

        /* Due notification */

        if (
            minutesLate >= 0 &&
            minutesLate < 30
        ) {
            notificationType = "due";
        }

        /* Missed notification after 30 minutes */

        else if (
            minutesLate >= 30
        ) {
            notificationType = "missed";
        }

        /* Not due yet */

        else {
            continue;
        }

        /* =========================
           PREVENT DUPLICATES
        ========================= */

        const stateRef = db
            .collection("families")
            .doc(familyId)
            .collection("pets")
            .doc(petId)
            .collection("reminders")
            .doc("notification-state");

        const stateSnap =
            await stateRef.get();

        const state =
            stateSnap.exists
                ? stateSnap.data()
                : {};

        const stateKey =
            `${taskName}_${today.date}_${notificationType}`;

        if (state[stateKey]) {
            console.log(
                `${taskName}: ${notificationType} notification already sent`
            );
            continue;
        }

        /* =========================
           NOTIFICATION MESSAGE
        ========================= */

        const icon =
            TASK_ICONS[taskName] || "🐾";

        let title;
        let body;

        if (notificationType === "due") {

            title =
                "PetOlife Care Reminder";

            body =
                `${icon} ${petName}'s ${taskName} is due now.`;

        } else {

            title =
                "PetOlife — Care Still Pending";

            body =
                `${icon} ${petName}'s ${taskName} is still pending. Please take care of your pet.`;
        }

        console.log(
            `Sending ${notificationType} notification for ${taskName}`
        );

        await sendNotification(
            tokens,
            title,
            body,
            `petolife-${petId}-${taskName}-${notificationType}`
        );

        /* =========================
           SAVE NOTIFICATION STATE
        ========================= */

        await stateRef.set(
            {
                [stateKey]: true
            },
            {
                merge: true
            }
        );
    }
}

/* =========================
   MAIN
========================= */

async function main() {

    console.log(
        "PetOlife reminder server started."
    );

    const reminderDocs =
        await db
            .collectionGroup("reminders")
            .get();

    console.log(
        `Found ${reminderDocs.size} reminder documents.`
    );

    const processedPets = new Set();

    for (const reminderDoc of reminderDocs.docs) {

        if (reminderDoc.id !== "reminders") {
            continue;
        }

        const pathParts =
            reminderDoc.ref.path.split("/");

        console.log(
            `Found reminder document: ${reminderDoc.ref.path}`
        );

        if (pathParts.length !== 6) {

            console.log(
                `Skipping unexpected path: ${reminderDoc.ref.path}`
            );

            continue;
        }

        const familyId =
            pathParts[1];

        const petId =
            pathParts[3];

        const petKey =
            `${familyId}/${petId}`;

        if (processedPets.has(petKey)) {
            continue;
        }

        processedPets.add(petKey);

        const petSnap =
            await db
                .collection("families")
                .doc(familyId)
                .collection("pets")
                .doc(petId)
                .get();

        if (!petSnap.exists) {

            console.log(
                `Pet not found: ${petKey}`
            );

            continue;
        }

        const pet =
            petSnap.data();

        const petName =
            pet.name || "Your pet";

        console.log(
            `Checking reminders for ${petName}`
        );

        await processPet(
            familyId,
            petId,
            petName
        );
    }

    console.log(
        "PetOlife reminder check completed."
    );
}

main().catch((error) => {

    console.error(
        "Reminder server error:",
        error
    );

    process.exit(1);
});
