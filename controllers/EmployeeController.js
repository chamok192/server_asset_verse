const { ObjectId } = require('mongodb');

class EmployeeController {
    constructor(collections) {
        this.userCollection = collections.userCollection;
        this.employeeAffiliationCollection = collections.employeeAffiliationCollection;
        this.assignedAssetCollection = collections.assignedAssetCollection;
        this.assetCollection = collections.assetCollection;
    }

    async getEmployees(req, res) {
        try {
            if (req.user.role !== 'hr' && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const hrEmail = req.user.email;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const skip = (page - 1) * limit;
            const query = { hrEmail: { $regex: new RegExp(`^${hrEmail}$`, 'i') }, status: 'active' };
            const affiliations = await this.employeeAffiliationCollection.find(query).skip(skip).limit(limit).toArray();
            const total = await this.employeeAffiliationCollection.countDocuments(query);
            const totalPages = Math.ceil(total / limit);

            const employees = [];
            for (const aff of affiliations) {
                const user = await this.userCollection.findOne({ email: aff.employeeEmail });
                if (user) {
                    const assetsCount = await this.assignedAssetCollection.countDocuments({ employeeEmail: aff.employeeEmail });
                    employees.push({
                        _id: user._id,
                        name: user.name,
                        email: user.email,
                        role: user.role,
                        phone: user.phone || '',
                        address: user.address || '',
                        profileImage: user.profileImage || '',
                        affiliationDate: aff.lastUpdate || aff.joinedAt,
                        assetsCount
                    });
                }
            }

            res.json({ data: employees, totalPages });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getEmployeeAssets(req, res) {
        try {
            const employeeEmail = req.user.email;
            const search = req.query.search || '';
            const type = req.query.type || '';

            const assignedAssets = await this.assignedAssetCollection.find({
                employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') },
                status: { $ne: 'returned' }
            }).toArray();
            console.log(`Found ${assignedAssets.length} assigned assets for ${employeeEmail}`);

            const populatedAssets = [];
            for (const assigned of assignedAssets) {
                let asset = null;
                try {
                    asset = await this.assetCollection.findOne({ _id: new ObjectId(assigned.assetId) });
                } catch (e) {
                    console.error('Invalid Asset ID in assignment:', assigned.assetId);
                }

                // Get company name from affiliation
                const affiliation = await this.employeeAffiliationCollection.findOne({
                    employeeEmail: employeeEmail,
                    hrEmail: assigned.hrEmail,
                    status: 'active'
                });

                // Also get HR user to check company name
                const hrUser = await this.userCollection.findOne({ email: assigned.hrEmail });

                // Determine company name with multiple fallbacks
                let companyName = 'Unknown Company';
                if (affiliation?.companyName && affiliation.companyName !== 'Unknown') {
                    companyName = affiliation.companyName;
                } else if (hrUser?.companyName) {
                    companyName = hrUser.companyName;
                } else if (assigned.companyName && assigned.companyName !== 'Unknown') {
                    companyName = assigned.companyName;
                } else if (hrUser?.name) {
                    companyName = `${hrUser.name}'s Company`;
                }

                const populatedAsset = {
                    _id: assigned._id,
                    assignmentDate: assigned.assignmentDate,
                    requestDate: assigned.assignmentDate,
                    returnDate: assigned.returnDate || null,
                    status: assigned.status,
                    companyName: companyName
                };

                if (asset) {
                    populatedAsset.assetName = asset.productName || asset.name || 'Unknown Asset';
                    populatedAsset.assetImage = asset.productImage || asset.image || '';
                    populatedAsset.assetType = asset.productType || asset.type || 'Unknown';
                } else {
                    console.warn(`Asset not found for assignment: ${assigned._id}, assetId: ${assigned.assetId}`);
                    populatedAsset.assetName = assigned.assetName || 'Unknown Asset';
                    populatedAsset.assetImage = '';
                    populatedAsset.assetType = assigned.assetType || 'Unknown';
                }

                populatedAssets.push(populatedAsset);
            }

            // Apply client-side filtering for search and type
            let filteredAssets = populatedAssets;

            if (search) {
                filteredAssets = filteredAssets.filter(asset =>
                    asset.assetName.toLowerCase().includes(search.toLowerCase())
                );
            }

            if (type && type !== 'all') {
                filteredAssets = filteredAssets.filter(asset =>
                    asset.assetType.toLowerCase() === type.toLowerCase()
                );
            }

            // Remove duplicates based on _id
            filteredAssets = filteredAssets.filter((asset, index, self) =>
                self.findIndex(a => a._id.toString() === asset._id.toString()) === index
            );

            console.log(`Returning ${filteredAssets.length} filtered assets (from ${populatedAssets.length} total)`);
            res.json({ success: true, data: filteredAssets });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getMyTeam(req, res) {
        try {
            const employeeEmail = req.user.email.toLowerCase();

            // Find the HR this employee is affiliated with
            const affiliation = await this.employeeAffiliationCollection.findOne({
                employeeEmail,
                status: 'active'
            });

            if (!affiliation) {
                return res.json({ success: true, data: [] });
            }

            // Get all employees affiliated with the same HR
            const teamAffiliations = await this.employeeAffiliationCollection.find({
                hrEmail: affiliation.hrEmail,
                status: 'active',
                employeeEmail: { $ne: employeeEmail } // Exclude self
            }).toArray();

            const teamMembers = [];
            for (const aff of teamAffiliations) {
                const user = await this.userCollection.findOne({ email: aff.employeeEmail });
                if (user) {
                    teamMembers.push({
                        _id: user._id,
                        name: user.name,
                        email: user.email,
                        profileImage: user.profileImage || '',
                        dateOfBirth: user.dateOfBirth,
                        phone: user.phone,
                        address: user.address
                    });
                }
            }

            res.json({ success: true, data: teamMembers });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async returnAsset(req, res) {
        try {
            const employeeEmail = req.user.email;
            const assetId = req.params.id;
            const { returnDate, notes } = req.body;

            // Find the assigned asset
            const assignedAsset = await this.assignedAssetCollection.findOne({
                _id: new ObjectId(assetId),
                employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') }
            });

            if (!assignedAsset) {
                return res.status(404).json({ error: 'Assigned asset not found' });
            }

            if (assignedAsset.status === 'returned') {
                return res.status(400).json({ error: 'Asset already returned' });
            }

            // Update the assigned asset
            await this.assignedAssetCollection.updateOne(
                { _id: new ObjectId(assetId) },
                {
                    $set: {
                        status: 'returned',
                        returnDate: returnDate ? new Date(returnDate) : new Date(),
                        notes: notes || ''
                    }
                }
            );

            // Increment the asset's available quantity
            const asset = await this.assetCollection.findOne({ _id: assignedAsset.assetId });
            if (asset) {
                const currentAvailable = asset.availableQuantity ?? asset.quantity ?? 0;
                await this.assetCollection.updateOne(
                    { _id: assignedAsset.assetId },
                    { $set: { availableQuantity: currentAvailable + 1 } }
                );
            }

            // Check if employee has any remaining assigned assets from this HR
            const remainingAssets = await this.assignedAssetCollection.countDocuments({
                employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') },
                hrEmail: assignedAsset.hrEmail,
                status: { $ne: 'returned' }
            });

            // If no remaining assets from this HR, deactivate the affiliation
            if (remainingAssets === 0) {
                await this.employeeAffiliationCollection.updateOne(
                    {
                        employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') },
                        hrEmail: assignedAsset.hrEmail
                    },
                    { $set: { status: 'inactive', lastUpdate: new Date() } }
                );
            }

            res.json({ success: true, message: 'Asset returned successfully' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async deleteEmployeeAsset(req, res) {
        try {
            const employeeEmail = req.user.email;
            const assetId = req.params.id;

            // Find the assigned asset first to get HR email
            const assignedAsset = await this.assignedAssetCollection.findOne({
                _id: new ObjectId(assetId),
                employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') }
            });

            if (!assignedAsset) {
                return res.status(404).json({ error: 'Assigned asset not found' });
            }

            // Delete the assigned asset
            const result = await this.assignedAssetCollection.deleteOne({
                _id: new ObjectId(assetId),
                employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') }
            });

            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'Assigned asset not found' });
            }

            // Check if employee has any remaining assigned assets from this HR
            const remainingAssets = await this.assignedAssetCollection.countDocuments({
                employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') },
                hrEmail: assignedAsset.hrEmail,
                status: { $ne: 'returned' }
            });

            // If no remaining assets from this HR, deactivate the affiliation
            if (remainingAssets === 0) {
                await this.employeeAffiliationCollection.updateOne(
                    {
                        employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') },
                        hrEmail: assignedAsset.hrEmail
                    },
                    { $set: { status: 'inactive', lastUpdate: new Date() } }
                );
            }

            res.json({ success: true, message: 'Asset assignment deleted successfully' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async removeEmployee(req, res) {
        try {
            if (req.user.role !== 'hr' && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const hrEmail = req.user.email;
            const employeeId = req.params.id;

            // 1. Find employee by ID to get email
            const employee = await this.userCollection.findOne({ _id: new ObjectId(employeeId) });
            if (!employee) return res.status(404).json({ error: 'Employee not found' });

            const employeeEmail = employee.email;
            console.log(`Attempting to remove employee ${employeeEmail} (id=${employeeId}) by HR ${hrEmail}`);

            // 2. Find assigned assets that are not returned and auto-return them
            const assignedAssets = await this.assignedAssetCollection.find({
                employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') },
                hrEmail: { $regex: new RegExp(`^${hrEmail}$`, 'i') },
                status: { $ne: 'returned' }
            }).toArray();

            console.log(`Found ${assignedAssets.length} assigned assets to auto-return for ${employeeEmail}`);

            for (const assigned of assignedAssets) {
                try {
                    // Mark as returned
                    await this.assignedAssetCollection.updateOne(
                        { _id: assigned._id },
                        { $set: { status: 'returned', returnDate: new Date(), notes: 'Auto-returned due to employee removal' } }
                    );

                    // Increment the available quantity on the asset document if possible
                    if (assigned.assetId) {
                        try {
                            const asset = await this.assetCollection.findOne({ _id: new ObjectId(assigned.assetId) });
                            if (asset) {
                                const currentAvailable = asset.availableQuantity ?? asset.quantity ?? asset.productQuantity ?? 0;
                                await this.assetCollection.updateOne({ _id: asset._id }, { $set: { availableQuantity: currentAvailable + 1 } });
                                console.log(`Incremented availableQuantity for asset ${asset._id}`);
                            } else {
                                console.warn('Asset referenced by assignment not found', assigned.assetId);
                            }
                        } catch (e) {
                            console.error('Error updating asset availableQuantity for assignment', assigned._id, e);
                        }
                    }
                } catch (e) {
                    console.error('Failed to auto-return assigned asset', assigned._id, e);
                }
            }

            // 3. Delete the affiliation record
            const result = await this.employeeAffiliationCollection.deleteOne({
                employeeEmail: { $regex: new RegExp(`^${employeeEmail}$`, 'i') },
                hrEmail: { $regex: new RegExp(`^${hrEmail}$`, 'i') }
            });

            console.log(`Affiliation delete result for ${employeeEmail} / ${hrEmail}:`, result);

            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'Employee affiliation not found' });
            }

            // 4. Decrement HR employee count
            const updateRes = await this.userCollection.updateOne(
                { email: { $regex: new RegExp(`^${hrEmail}$`, 'i') } },
                { $inc: { currentEmployees: -1 } }
            );
            console.log(`HR currentEmployees decrement result:`, updateRes);

            res.json({ success: true, message: `Employee removed successfully; ${assignedAssets.length} assets auto-returned.` });
        } catch (error) {
            console.error('Error in removeEmployee:', error);
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = EmployeeController;