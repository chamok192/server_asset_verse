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
            profileImage: user.profileImage
        }
    });
}));
